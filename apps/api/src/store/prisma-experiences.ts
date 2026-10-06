import {
  ExperienceSnapshotSchema,
  type AgentExperience,
  type ExperienceSnapshot,
} from '@werewolf/shared';
import { Prisma, type PrismaClient } from '../generated/prisma/client';
import {
  experienceRows,
  checkExperienceEnable,
  checkExperienceRevision,
  editedExperience,
  experienceIndexView,
  ExperienceConflictError,
  type ExperienceIndexState,
  initialExperienceState,
  type ExperienceGeneration,
  type ExperienceState,
  type ExperienceStore,
  type ExperienceScope,
  reviewedExperience,
} from './experiences';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const generation = (row: Prisma.ExperienceGenerationModel): ExperienceGeneration => ({
  ...row,
  state: row.state as unknown as ExperienceState,
});
const experience = (row: Prisma.AgentExperienceModel): AgentExperience => ({
  ...(row.content as unknown as AgentExperience),
  enabled: row.enabled,
  version: row.version,
  archived: row.archived,
  revision: row.revision,
  history: row.history as unknown as ExperienceSnapshot[],
  ...experienceIndexView(
    row.indexState as unknown as ExperienceIndexState | null,
    row.embedding.length > 0,
  ),
  indexed: row.embedding.length > 0,
  createdAt: row.createdAt.toISOString(),
});
const record = (row: Prisma.AgentExperienceModel) => ({
  item: experience(row),
  state: row.indexState as unknown as ExperienceIndexState | null,
  embeddingKey: row.embeddingKey,
});
type RetrievedExperience = Pick<
  Prisma.AgentExperienceModel,
  'content' | 'version' | 'revision' | 'createdAt'
>;
const retrievedExperience = (row: RetrievedExperience): AgentExperience => ({
  ...(row.content as unknown as AgentExperience),
  version: row.version,
  revision: row.revision,
  createdAt: row.createdAt.toISOString(),
  enabled: true,
  archived: false,
  indexed: true,
});
const scopeSql = (scope: ExperienceScope) => Prisma.sql`
  e.enabled = true AND e.archived = false AND e.board_id = ${scope.boardId} AND e.role = ${scope.role}
  AND g.game_id <> ${scope.gameId}
  AND e.content->'actionTypes' ? ${scope.actionType ?? ''}
  AND (e.content->>'minDay')::integer <= ${scope.day ?? 0}
  AND e.content->>'firstDayOnly' IS NOT NULL
  AND ((e.content->>'firstDayOnly')::boolean = false OR ${scope.day ?? 0} = 1)
  AND e.content->'reviews'->-1->>'decision' = 'approved'
  AND (e.content->'reviews'->-1->>'version')::integer = e.version
`;

export function prismaExperiences(client: PrismaClient): ExperienceStore {
  return {
    async hasCandidates(scope) {
      const rows = await client.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS(SELECT 1 FROM agent_experiences e
          JOIN experience_generations g ON g.id = e.generation_id WHERE ${scopeSql(scope)})`;
      return rows[0]!.exists;
    },
    async lexicalCandidates(scope, key) {
      const rows = await client.$queryRaw<RetrievedExperience[]>`
        SELECT e.content, e.version, e.revision, e.created_at AS "createdAt" FROM agent_experiences e
        JOIN experience_generations g ON g.id = e.generation_id
        WHERE ${scopeSql(scope)} AND e.embedding_key = ${key} AND cardinality(e.embedding) > 0
        ORDER BY e.id ASC`;
      return rows.map(retrievedExperience);
    },
    async search(scope, key, vector, limit) {
      // PostgreSQL 精确余弦检索，先过滤适用范围，只返回有界候选；不把全库向量搬到应用层。
      const rows = await client.$queryRaw<Array<RetrievedExperience & { similarity: number }>>`
        SELECT e.content, e.version, e.revision, e.created_at AS "createdAt",
          (SELECT sum(v.x * q.x) / NULLIF(sqrt(sum(v.x * v.x) * sum(q.x * q.x)), 0)
           FROM unnest(e.embedding) WITH ORDINALITY AS v(x, i)
           JOIN unnest(${vector}::double precision[]) WITH ORDINALITY AS q(x, i) USING (i)) AS similarity
        FROM agent_experiences e JOIN experience_generations g ON g.id = e.generation_id
        WHERE ${scopeSql(scope)} AND e.embedding_key = ${key}
          AND cardinality(e.embedding) = ${vector.length}
        ORDER BY similarity DESC, e.id ASC LIMIT ${limit}
      `;
      return rows.map((row) => ({
        experience: retrievedExperience(row),
        similarity: row.similarity,
      }));
    },
    async writeVectors(key, rows) {
      await client.$transaction(
        rows.map((row) =>
          client.agentExperience.updateMany({
            where: { id: row.id, version: 1, indexState: { equals: Prisma.DbNull } },
            data: { embedding: row.vector, embeddingKey: key },
          }),
        ),
      );
    },
    async list(agentId) {
      return (
        await client.agentExperience.findMany({
          where: { agentId },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        })
      ).map(experience);
    },
    async find(id) {
      const row = await client.agentExperience.findUnique({ where: { id } });
      return row ? record(row) : null;
    },
    async related(boardId, role) {
      return (
        await client.agentExperience.findMany({
          where: { boardId, role, archived: false },
          orderBy: { id: 'asc' },
        })
      ).map(experience);
    },
    async review(agentId, id, input) {
      return client.$transaction(async (tx) => {
        const row = await tx.agentExperience.findFirst({
          where: { id, agentId },
          include: { generation: { select: { state: true } } },
        });
        if (!row) return false;
        const sources = (row.generation.state as unknown as ExperienceState).input!.sources;
        const next = reviewedExperience(experience(row), input, sources);
        const saved = await tx.agentExperience.updateMany({
          where: { id, agentId, revision: input.revision },
          data: {
            content: json({ ...ExperienceSnapshotSchema.parse(next), reviews: next.reviews }),
            enabled: false,
            revision: { increment: 1 },
          },
        });
        if (saved.count !== 1) throw new ExperienceConflictError('经验已被修改，请刷新后重试');
        return true;
      });
    },
    async edit(agentId, id, revision, content) {
      return client.$transaction(async (tx) => {
        const row = await tx.agentExperience.findFirst({ where: { id, agentId } });
        if (!row) return false;
        const item = experience(row);
        checkExperienceRevision(item, revision);
        const next = editedExperience(item, content);
        if (next === item) return true;
        const saved = await tx.agentExperience.updateMany({
          where: { id, agentId, revision },
          data: {
            content: json({ ...ExperienceSnapshotSchema.parse(next), reviews: next.reviews }),
            version: next.version,
            revision: { increment: 1 },
            history: json(next.history),
            enabled: false,
            embedding: [],
            embeddingKey: null,
            indexState: json({ status: 'draft', failure: null }),
          },
        });
        if (saved.count !== 1) throw new ExperienceConflictError('经验已被修改，请刷新后重试');
        return true;
      });
    },
    async archive(agentId, id, revision, archived) {
      const saved = await client.agentExperience.updateMany({
        where: { id, agentId, revision },
        data: { archived, enabled: false, revision: { increment: 1 } },
      });
      if (saved.count === 1) return true;
      if (await client.agentExperience.findFirst({ where: { id, agentId } }))
        throw new ExperienceConflictError('经验已被修改，请刷新后重试');
      return false;
    },
    async saveIndex(previous, state, vector) {
      const saved = await client.agentExperience.updateMany({
        where: {
          id: previous.item.id,
          version: previous.item.version,
          ...(state.status === 'pending' ? { enabled: false } : {}),
          indexState: { equals: previous.state === null ? Prisma.DbNull : json(previous.state) },
        },
        data: {
          indexState: json(state),
          ...(vector
            ? { embedding: vector, embeddingKey: state.task!.key }
            : state.status !== 'ready'
              ? { embedding: [], embeddingKey: null }
              : {}),
        },
      });
      if (saved.count !== 1)
        throw new ExperienceConflictError('经验版本或索引状态已变化，请刷新后重试');
    },
    async toggle(agentId, id, enabled, revision, key) {
      const row = await client.agentExperience.findFirst({ where: { id, agentId } });
      if (!row) return false;
      checkExperienceRevision(experience(row), revision);
      checkExperienceEnable(record(row), enabled, key);
      const saved = await client.agentExperience.updateMany({
        where: {
          id,
          agentId,
          revision: row.revision,
          indexState: { equals: row.indexState === null ? Prisma.DbNull : json(row.indexState) },
        },
        data: { enabled, revision: { increment: 1 } },
      });
      if (saved.count !== 1) throw new ExperienceConflictError('经验或索引已变化，请刷新后重试');
      return true;
    },
    async findSource(gameId, playerId, reviewVersion) {
      const row = await client.experienceGeneration.findUnique({
        where: { gameId_playerId_reviewVersion: { gameId, playerId, reviewVersion } },
      });
      return row ? generation(row) : null;
    },
    async findGeneration(id) {
      const row = await client.experienceGeneration.findUnique({ where: { id } });
      return row ? generation(row) : null;
    },
    async open(input) {
      const { gameId, playerId, reviewVersion } = input;
      return generation(
        await client.experienceGeneration.upsert({
          where: { gameId_playerId_reviewVersion: { gameId, playerId, reviewVersion } },
          create: { ...input, state: json(initialExperienceState()) },
          update: {},
        }),
      );
    },
    async save(row, next) {
      const saved = await client.experienceGeneration.updateMany({
        where: { id: row.id, state: { equals: json(row.state) } },
        data: { state: json(next) },
      });
      if (saved.count !== 1) throw new Error('经验任务状态已变化，请刷新后重试');
    },
    async complete(row, result) {
      await client.$transaction(async (tx) => {
        const saved = await tx.experienceGeneration.updateMany({
          where: { id: row.id, state: { equals: json(row.state) } },
          data: { state: json({ ...row.state, status: 'completed', failure: null, result }) },
        });
        if (saved.count !== 1) throw new Error('经验任务状态已变化，请刷新后重试');
        const rows = experienceRows(row, result);
        if (rows.length)
          await tx.agentExperience.createMany({
            data: rows.map((item, ordinal) => ({
              id: item.id,
              agentId: item.agentId,
              generationId: item.generationId,
              boardId: item.boardId,
              role: item.role,
              ordinal,
              content: json(item),
              enabled: false,
            })),
          });
      });
    },
  };
}
