import type { AgentExperience } from '@werewolf/shared';
import { cosine } from '../llm/embedding';
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
  type ExperienceStore,
} from './experiences';
const copy = <T>(value: T): T => structuredClone(value);

export function memoryExperiences(): ExperienceStore {
  const generations = new Map<string, ExperienceGeneration>();
  const experiences = new Map<string, AgentExperience>();
  const vectors = new Map<string, { key: string; vector: number[] }>();
  const indexes = new Map<string, ExperienceIndexState>();
  const record = (item: AgentExperience) => ({
    item: { ...item, ...experienceIndexView(indexes.get(item.id) ?? null, !!item.indexed) },
    state: indexes.get(item.id) ?? null,
    embeddingKey: vectors.get(item.id)?.key ?? null,
  });
  const source = (gameId: string, playerId: string, reviewVersion: string) =>
    [...generations.values()].find(
      (row) =>
        row.gameId === gameId && row.playerId === playerId && row.reviewVersion === reviewVersion,
    ) ?? null;
  const check = (row: ExperienceGeneration) => {
    if (JSON.stringify(generations.get(row.id)?.state) !== JSON.stringify(row.state))
      throw new Error('经验任务状态已变化，请刷新后重试');
  };
  return {
    async hasCandidates({ boardId, role, gameId }) {
      return [...experiences.values()].some(
        (row) =>
          row.enabled &&
          !row.archived &&
          row.boardId === boardId &&
          row.role === role &&
          row.sourceGameId !== gameId,
      );
    },
    async search({ boardId, role, gameId }, key, vector, limit) {
      return copy(
        [...experiences.values()]
          .filter(
            (row) =>
              row.enabled &&
              !row.archived &&
              row.boardId === boardId &&
              row.role === role &&
              row.sourceGameId !== gameId &&
              vectors.get(row.id)?.key === key,
          )
          .map((experience) => ({
            experience,
            similarity: cosine(vectors.get(experience.id)!.vector, vector),
          }))
          .toSorted(
            (a, b) => b.similarity - a.similarity || a.experience.id.localeCompare(b.experience.id),
          )
          .slice(0, limit),
      );
    },
    async writeVectors(key, rows) {
      for (const { id, vector } of rows) {
        const row = experiences.get(id);
        if (!row) throw new Error('经验不存在');
        // 提炼任务只写原始 v1 的向量，编辑后的版本由独立索引任务处理。
        if (row.version !== 1) continue;
        vectors.set(id, copy({ key, vector }));
        experiences.set(id, { ...row, indexed: true });
      }
    },
    async list(agentId) {
      return copy(
        [...experiences.values()]
          .filter((row) => row.agentId === agentId)
          .toReversed()
          .map((item) => record(item).item),
      );
    },
    async find(id) {
      const item = experiences.get(id);
      return item ? copy(record(item)) : null;
    },
    async edit(agentId, id, revision, content) {
      const item = experiences.get(id);
      if (!item || item.agentId !== agentId) return false;
      checkExperienceRevision(item, revision);
      const next = editedExperience(item, content);
      if (next !== item) {
        experiences.set(id, copy(next));
        vectors.delete(id);
        indexes.set(id, { status: 'draft', failure: null });
      }
      return true;
    },
    async archive(agentId, id, revision, archived) {
      const item = experiences.get(id);
      if (!item || item.agentId !== agentId) return false;
      checkExperienceRevision(item, revision);
      experiences.set(id, { ...item, archived, enabled: false, revision: revision + 1 });
      return true;
    },
    async saveIndex(previous, state, vector) {
      const item = experiences.get(previous.item.id);
      if (
        !item ||
        item.version !== previous.item.version ||
        (previous.state?.status === 'ready' && state.status === 'pending' && item.enabled) ||
        JSON.stringify(indexes.get(item.id) ?? null) !== JSON.stringify(previous.state)
      )
        throw new ExperienceConflictError('经验版本或索引状态已变化，请刷新后重试');
      indexes.set(item.id, copy(state));
      if (vector) {
        vectors.set(item.id, copy({ key: state.task!.key, vector }));
        experiences.set(item.id, { ...item, indexed: true });
      } else if (state.status !== 'ready') {
        vectors.delete(item.id);
        experiences.set(item.id, { ...item, indexed: false });
      }
    },
    async toggle(agentId, id, enabled, revision, key) {
      const row = experiences.get(id);
      if (!row || row.agentId !== agentId) return false;
      checkExperienceRevision(row, revision);
      checkExperienceEnable(record(row), enabled, key);
      experiences.set(id, { ...row, enabled, revision: (row.revision ?? 0) + 1 });
      return true;
    },
    async findSource(...args) {
      return copy(source(...args));
    },
    async findGeneration(id) {
      return copy(generations.get(id) ?? null);
    },
    async open(input) {
      const row = source(input.gameId, input.playerId, input.reviewVersion) ?? {
        ...input,
        state: initialExperienceState(),
      };
      generations.set(row.id, row);
      return copy(row);
    },
    async save(row, next) {
      check(row);
      generations.set(row.id, copy({ ...row, state: next }));
    },
    async complete(row, result) {
      check(row);
      for (const experience of experienceRows(row, result))
        experiences.set(experience.id, experience);
      generations.set(
        row.id,
        copy({ ...row, state: { ...row.state, status: 'completed', failure: null, result } }),
      );
    },
  };
}
