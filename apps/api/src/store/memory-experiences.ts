import type { AgentExperience } from '@werewolf/shared';
import { cosine } from '../llm/embedding';
import {
  experienceRows,
  initialExperienceState,
  type ExperienceGeneration,
  type ExperienceStore,
} from './experiences';
const copy = <T>(value: T): T => structuredClone(value);

export function memoryExperiences(): ExperienceStore {
  const generations = new Map<string, ExperienceGeneration>();
  const experiences = new Map<string, AgentExperience>();
  const vectors = new Map<string, { key: string; vector: number[] }>();
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
        vectors.set(id, copy({ key, vector }));
        experiences.set(id, { ...row, indexed: true });
      }
    },
    async list(agentId) {
      return copy([...experiences.values()].filter((row) => row.agentId === agentId).toReversed());
    },
    async toggle(agentId, id, enabled) {
      const row = experiences.get(id);
      if (!row || row.agentId !== agentId) return false;
      experiences.set(id, { ...row, enabled });
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
