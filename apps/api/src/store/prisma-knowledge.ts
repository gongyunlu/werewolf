import { randomUUID } from 'node:crypto';
import { KnowledgeContentSchema, KnowledgeSnapshotSchema } from '@werewolf/shared';
import { Prisma, type PrismaClient } from '../generated/prisma/client';
import {
  KnowledgeConflictError,
  knowledgeHash,
  type KnowledgeIndexState,
  type KnowledgeRecord,
  type KnowledgeRevision,
  type KnowledgeScope,
  type KnowledgeStore,
} from './knowledge';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const versionSelect = {
  id: true,
  itemId: true,
  version: true,
  content: true,
  contentHash: true,
  state: true,
  createdAt: true,
} as const;
const include = { versions: { select: versionSelect, orderBy: { version: 'asc' as const } } };
type Row = Prisma.KnowledgeVersionGetPayload<{ select: typeof versionSelect }>;
const versionOf = (row: Row): KnowledgeRevision => ({
  id: row.itemId,
  versionId: row.id,
  version: row.version,
  content: KnowledgeContentSchema.parse(row.content),
  contentHash: row.contentHash,
  state: row.state as unknown as KnowledgeIndexState,
  createdAt: row.createdAt.toISOString(),
});
const recordOf = (
  row: Prisma.KnowledgeItemGetPayload<{ include: typeof include }>,
): KnowledgeRecord => ({
  id: row.id,
  revision: row.revision,
  activeVersionId: row.activeVersionId,
  versions: row.versions.map(versionOf),
});
const scopeWhere = (scope: KnowledgeScope): Prisma.KnowledgeVersionWhereInput => ({
  activeFor: { isNot: null },
  kind: 'strategy',
  boardIds: { has: scope.boardId },
  roles: { has: scope.role },
  minDay: { lte: scope.day },
  actionTypes: { has: scope.actionType },
  ...(scope.day === 1 ? {} : { firstDayOnly: false }),
});

export function prismaKnowledge(client: PrismaClient): KnowledgeStore {
  return {
    async list() {
      return (await client.knowledgeItem.findMany({ include, orderBy: { createdAt: 'desc' } })).map(
        recordOf,
      );
    },
    async find(id) {
      const row = await client.knowledgeItem.findUnique({ where: { id }, include });
      return row ? recordOf(row) : null;
    },
    async version(id) {
      const row = await client.knowledgeVersion.findUnique({
        where: { id },
        select: versionSelect,
      });
      return row ? versionOf(row) : null;
    },
    saveDraft(id, revision, content) {
      return client.$transaction(async (tx) => {
        await tx.knowledgeItem.upsert({ where: { id }, create: { id }, update: {} });
        // 编辑和首次索引共用条目锁，不能在索引固定正文的同时改写草稿。
        await tx.$queryRaw`SELECT id FROM knowledge_items WHERE id = ${id}::uuid FOR UPDATE`;
        const row = await tx.knowledgeItem.findUniqueOrThrow({ where: { id }, include });
        const latest = row.versions.at(-1);
        const hash = knowledgeHash(content);
        if (latest?.contentHash === hash) return recordOf(row);
        if (row.revision !== revision)
          throw new KnowledgeConflictError('知识已被修改，请刷新后重试');
        const data = {
          content: json(content),
          contentHash: hash,
          kind: content.kind,
          boardIds: content.boardIds,
          roles: content.roles,
          actionTypes: content.actionTypes,
          firstDayOnly: content.firstDayOnly,
          minDay: content.minDay,
          state: json({ status: 'draft', failure: null }),
        };
        if (latest && (latest.state as unknown as KnowledgeIndexState).status === 'draft')
          await tx.knowledgeVersion.update({ where: { id: latest.id }, data });
        else
          await tx.knowledgeVersion.create({
            data: {
              ...data,
              id: randomUUID(),
              itemId: id,
              version: (latest?.version ?? 0) + 1,
            },
          });
        return recordOf(
          await tx.knowledgeItem.update({
            where: { id },
            data: { revision: { increment: 1 } },
            include,
          }),
        );
      });
    },
    async activate(id, revision, versionId, key) {
      await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM knowledge_items WHERE id = ${id}::uuid FOR UPDATE`;
        if (versionId) {
          const row = await tx.knowledgeVersion.findUnique({ where: { id: versionId } });
          if (
            !row ||
            row.itemId !== id ||
            row.kind !== 'strategy' ||
            row.embeddingKey !== key ||
            !row.embedding.length ||
            (row.state as unknown as KnowledgeIndexState).status !== 'ready'
          )
            throw new KnowledgeConflictError('只能启用已完成当前向量索引的策略版本');
        }
        const saved = await tx.knowledgeItem.updateMany({
          where: { id, revision },
          data: { activeVersionId: versionId, revision: { increment: 1 } },
        });
        if (saved.count !== 1) throw new KnowledgeConflictError('知识已被修改，请刷新后重试');
      });
    },
    async saveIndex(previous, state, vector) {
      await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM knowledge_items WHERE id = ${previous.id}::uuid FOR UPDATE`;
        const saved = await tx.knowledgeVersion.updateMany({
          where: {
            id: previous.versionId,
            contentHash: previous.contentHash,
            state: { equals: json(previous.state) },
          },
          data: {
            state: json(state),
            ...(vector ? { embedding: vector, embeddingKey: state.task!.key } : {}),
          },
        });
        if (saved.count !== 1) throw new KnowledgeConflictError('知识索引状态已变化，请刷新后重试');
      });
    },
    async hasCandidates(scope) {
      return (await client.knowledgeVersion.count({ where: scopeWhere(scope) })) > 0;
    },
    async search(scope, key, vector, limit) {
      const rows = await client.$queryRaw<Array<Row & { similarity: number }>>`
        SELECT v.id, v.item_id AS "itemId", v.version, v.content,
          (SELECT sum(x.n * q.n) / NULLIF(sqrt(sum(x.n * x.n) * sum(q.n * q.n)), 0)
           FROM unnest(v.embedding) WITH ORDINALITY AS x(n, i)
           JOIN unnest(${vector}::double precision[]) WITH ORDINALITY AS q(n, i) USING (i)) AS similarity
        FROM knowledge_versions v JOIN knowledge_items k ON k.active_version_id = v.id
        WHERE v.kind = 'strategy' AND ${scope.boardId} = ANY(v.board_ids)
          AND ${scope.role} = ANY(v.roles) AND ${scope.actionType} = ANY(v.action_types)
          AND (NOT v.first_day_only OR ${scope.day} = 1)
          AND v.min_day <= ${scope.day}
          AND v.embedding_key = ${key} AND cardinality(v.embedding) = ${vector.length}
        ORDER BY similarity DESC, v.id ASC LIMIT ${limit}
      `;
      return rows.map((row) => ({
        knowledge: KnowledgeSnapshotSchema.parse({
          id: row.itemId,
          versionId: row.id,
          version: row.version,
          content: row.content,
        }),
        similarity: row.similarity,
      }));
    },
  };
}
