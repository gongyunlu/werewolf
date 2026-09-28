import { randomUUID } from 'node:crypto';
import { KnowledgeConflictError, type KnowledgeStore } from './knowledge';
import {
  confirmedCandidate,
  initialCaptureState,
  requireCandidate,
  type CaptureRecord,
  type KnowledgeImportStore,
} from './knowledge-imports';

const copy = <T>(value: T): T => structuredClone(value);
export function memoryKnowledgeImports(knowledge: KnowledgeStore): KnowledgeImportStore {
  const rows = new Map<string, CaptureRecord>();
  const sources = new Map<string, string>();
  let confirming = Promise.resolve();
  return {
    async open(batchId, urls) {
      const existing = [...rows.values()].filter((row) => row.batchId === batchId);
      if (existing.length) {
        if (existing.length !== urls.length || existing.some((row) => !urls.includes(row.url)))
          throw new KnowledgeConflictError('批次编号已用于其他链接');
        return copy(existing);
      }
      return urls.map((url) => {
        const sourceId = sources.get(url) ?? randomUUID();
        sources.set(url, sourceId);
        const row = {
          id: randomUUID(),
          batchId,
          sourceId,
          url,
          revision: 0,
          createdAt: new Date().toISOString(),
          state: initialCaptureState(),
        };
        rows.set(row.id, row);
        return copy(row);
      });
    },
    async list() {
      return copy([...rows.values()].toReversed().slice(0, 100));
    },
    async find(id) {
      return copy(rows.get(id) ?? null);
    },
    async previous(row) {
      return copy(
        [...rows.values()]
          .toReversed()
          .find(
            (r) =>
              r.id !== row.id &&
              r.sourceId === row.sourceId &&
              r.createdAt <= row.createdAt &&
              r.state.snapshot,
          ) ?? null,
      );
    },
    async save(row, state) {
      if (rows.get(row.id)?.revision !== row.revision)
        throw new KnowledgeConflictError('采集整理任务已变化，请刷新后重试');
      const next = { ...row, state, revision: row.revision + 1 };
      rows.set(row.id, copy(next));
      return copy(next);
    },
    async confirm(id, candidateId, content, expectedRevision) {
      const previous = confirming;
      let release!: () => void;
      confirming = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const row = rows.get(id)!;
        const candidate = requireCandidate(row, candidateId);
        if (candidate.status === 'saved') return copy(row);
        if (candidate.status !== 'pending') throw new KnowledgeConflictError('此候选已舍弃');
        const item = await knowledge.saveDraft(candidate.itemId, expectedRevision, content);
        row.state.candidates = row.state.candidates.map((c) =>
          c.id === candidateId ? confirmedCandidate(candidate, item) : c,
        );
        row.revision++;
        return copy(row);
      } finally {
        release();
      }
    },
    async discard(id, candidateId) {
      await confirming;
      const row = rows.get(id)!;
      const candidate = requireCandidate(row, candidateId);
      if (candidate.status === 'saved')
        throw new KnowledgeConflictError('已保存候选请到知识库管理');
      candidate.status = 'discarded';
      row.revision++;
      return copy(row);
    },
  };
}
