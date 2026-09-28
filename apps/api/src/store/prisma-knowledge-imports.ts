import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { KnowledgeConflictError } from './knowledge';
import {
  confirmedCandidate,
  initialCaptureState,
  requireCandidate,
  type CaptureRecord,
  type CaptureState,
  type KnowledgeImportStore,
} from './knowledge-imports';
import { saveKnowledgeDraft } from './prisma-knowledge';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const include = { source: true } as const;
const record = (
  row: Prisma.KnowledgeCaptureGetPayload<{ include: typeof include }>,
): CaptureRecord => ({
  id: row.id,
  batchId: row.batchId,
  sourceId: row.sourceId,
  url: row.source.url,
  revision: row.revision,
  createdAt: row.createdAt.toISOString(),
  state: row.state as unknown as CaptureState,
});
export function prismaKnowledgeImports(client: PrismaClient): KnowledgeImportStore {
  return {
    async open(batchId, urls) {
      return client.$transaction(async (tx) => {
        // 同一批次的并发请求先串行化，避免不同 URL 集合混进同一批次。
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${batchId}, 0))::text`;
        const existing = await tx.knowledgeCapture.findMany({ where: { batchId }, include });
        if (existing.length) {
          if (
            existing.length !== urls.length ||
            existing.some((row) => !urls.includes(row.source.url))
          )
            throw new KnowledgeConflictError('批次编号已用于其他链接');
          return existing.map(record);
        }
        await tx.knowledgeSource.createMany({
          data: urls.map((url) => ({ id: randomUUID(), url })),
          skipDuplicates: true,
        });
        const sources = await tx.knowledgeSource.findMany({ where: { url: { in: urls } } });
        await tx.knowledgeCapture.createMany({
          data: sources.map((source) => ({
            id: randomUUID(),
            batchId,
            sourceId: source.id,
            state: json(initialCaptureState()),
          })),
          skipDuplicates: true,
        });
        return (
          await tx.knowledgeCapture.findMany({
            where: { batchId },
            include,
            orderBy: { createdAt: 'asc' },
          })
        ).map(record);
      });
    },
    async list() {
      return (
        await client.knowledgeCapture.findMany({
          include,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100,
        })
      ).map(record);
    },
    async find(id) {
      const row = await client.knowledgeCapture.findUnique({ where: { id }, include });
      return row ? record(row) : null;
    },
    async previous(row) {
      const previous = await client.knowledgeCapture.findFirst({
        where: {
          sourceId: row.sourceId,
          id: { not: row.id },
          createdAt: { lte: new Date(row.createdAt) },
          state: { path: ['snapshot'], not: Prisma.AnyNull },
        },
        include,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return previous ? record(previous) : null;
    },
    async save(row, state) {
      const result = await client.knowledgeCapture.updateMany({
        where: { id: row.id, revision: row.revision },
        data: { state: json(state), revision: { increment: 1 } },
      });
      if (result.count !== 1) throw new KnowledgeConflictError('采集整理任务已变化，请刷新后重试');
      return { ...row, state, revision: row.revision + 1 };
    },
    async confirm(id, candidateId, content, expectedRevision) {
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM knowledge_captures WHERE id = ${id}::uuid FOR UPDATE`;
        const row = record(await tx.knowledgeCapture.findUniqueOrThrow({ where: { id }, include }));
        const candidate = requireCandidate(row, candidateId);
        if (candidate.status === 'saved') return row;
        if (candidate.status !== 'pending') throw new KnowledgeConflictError('此候选已舍弃');
        const item = await saveKnowledgeDraft(tx, candidate.itemId, expectedRevision, content);
        const state = {
          ...row.state,
          candidates: row.state.candidates.map((c) =>
            c.id === candidateId ? confirmedCandidate(candidate, item) : c,
          ),
        };
        return record(
          await tx.knowledgeCapture.update({
            where: { id },
            data: { state: json(state), revision: { increment: 1 } },
            include,
          }),
        );
      });
    },
    async discard(id, candidateId) {
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM knowledge_captures WHERE id = ${id}::uuid FOR UPDATE`;
        const row = record(await tx.knowledgeCapture.findUniqueOrThrow({ where: { id }, include }));
        const candidate = requireCandidate(row, candidateId);
        if (candidate.status === 'saved')
          throw new KnowledgeConflictError('已保存候选请到知识库管理');
        candidate.status = 'discarded';
        return record(
          await tx.knowledgeCapture.update({
            where: { id },
            data: { state: json(row.state), revision: { increment: 1 } },
            include,
          }),
        );
      });
    },
  };
}
