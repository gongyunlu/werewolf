import { randomUUID } from 'node:crypto';
import { KnowledgeSnapshotSchema } from '@werewolf/shared';
import { cosine } from '../llm/embedding';
import {
  KnowledgeConflictError,
  knowledgeHash,
  type KnowledgeRecord,
  type KnowledgeScope,
  type KnowledgeRevision,
  type KnowledgeStore,
} from './knowledge';

export function memoryKnowledge(): KnowledgeStore {
  const rows = new Map<string, KnowledgeRecord>();
  const vectors = new Map<string, { key: string; vector: number[] }>();
  const version = (id: string) =>
    [...rows.values()].flatMap((row) => row.versions).find((row) => row.versionId === id);
  const candidates = (scope: KnowledgeScope) =>
    [...rows.values()].flatMap((item) => {
      const row = item.versions.find((v) => v.versionId === item.activeVersionId);
      const c = row?.content;
      return row &&
        c?.kind === 'strategy' &&
        c.boardIds.includes(scope.boardId) &&
        c.roles.some((role) => role === scope.role) &&
        c.actionTypes.some((action) => action === scope.actionType) &&
        (!c.firstDayOnly || scope.day === 1) &&
        c.minDay <= scope.day
        ? [row]
        : [];
    });
  return {
    async list() {
      return structuredClone([...rows.values()].toReversed());
    },
    async find(id) {
      return structuredClone(rows.get(id) ?? null);
    },
    async version(id) {
      return structuredClone(version(id) ?? null);
    },
    async saveDraft(id, revision, content) {
      const row = rows.get(id) ?? { id, revision: 0, activeVersionId: null, versions: [] };
      const latest = row.versions.at(-1);
      const hash = knowledgeHash(content);
      if (latest?.contentHash === hash) return structuredClone(row);
      if (row.revision !== revision) throw new KnowledgeConflictError('知识已被修改，请刷新后重试');
      const next: KnowledgeRevision = {
        id,
        versionId: latest?.state.status === 'draft' ? latest.versionId : randomUUID(),
        version: latest?.state.status === 'draft' ? latest.version : (latest?.version ?? 0) + 1,
        content: structuredClone(content),
        contentHash: hash,
        state: { status: 'draft', failure: null },
        createdAt: new Date().toISOString(),
      };
      if (latest?.state.status === 'draft') row.versions[row.versions.length - 1] = next;
      else row.versions.push(next);
      row.revision++;
      rows.set(id, row);
      return structuredClone(row);
    },
    async activate(id, revision, versionId, key) {
      const row = rows.get(id);
      if (!row || row.revision !== revision)
        throw new KnowledgeConflictError('知识已被修改，请刷新后重试');
      const v = row.versions.find((entry) => entry.versionId === versionId);
      if (
        versionId &&
        (!v ||
          v.content.kind !== 'strategy' ||
          v.state.status !== 'ready' ||
          vectors.get(versionId)?.key !== key)
      )
        throw new KnowledgeConflictError('只能启用已完成当前向量索引的策略版本');
      row.activeVersionId = versionId;
      row.revision++;
    },
    async saveIndex(previous, state, vector) {
      const row = version(previous.versionId);
      if (
        !row ||
        row.contentHash !== previous.contentHash ||
        JSON.stringify(row.state) !== JSON.stringify(previous.state)
      )
        throw new KnowledgeConflictError('知识索引状态已变化，请刷新后重试');
      row.state = structuredClone(state);
      if (vector) vectors.set(row.versionId, { key: state.task!.key, vector: [...vector] });
    },
    async hasCandidates(scope) {
      return candidates(scope).length > 0;
    },
    async search(scope, key, vector, limit) {
      return candidates(scope)
        .flatMap((row) => {
          const stored = vectors.get(row.versionId);
          return stored?.key === key
            ? [
                {
                  knowledge: KnowledgeSnapshotSchema.parse(row),
                  similarity: cosine(stored.vector, vector),
                },
              ]
            : [];
        })
        .toSorted(
          (a, b) => b.similarity - a.similarity || a.knowledge.id.localeCompare(b.knowledge.id),
        )
        .slice(0, limit);
    },
  };
}
