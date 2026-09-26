import type { AgentExperience, ExperienceResult, ExperienceSource } from '@werewolf/shared';
import type { EmbeddingTask } from '../experience/embedding-task';
import type { ModelResponse } from '../llm/model-port';
import type { PromptTemplate } from '../llm/prompt-template';
import type { RosterSeat } from './games';
import { createHash } from 'node:crypto';

export interface ExperienceInput {
  boardId: string;
  role: string;
  seat: RosterSeat;
  review: unknown;
  sources: ExperienceSource[];
  prompts: PromptTemplate[];
}
export interface ExperienceAttempt {
  callId: string;
  /** 未标记的历史答复使用完整来源 ID；新请求使用短编号。 */
  citationFormat?: 'short_ids';
  status: 'pending' | 'responded' | 'invalid' | 'failed' | 'accepted';
  response?: Pick<ModelResponse, 'content' | 'toolCall' | 'reasoning'>;
  diagnosis?: string;
  durationMs?: number;
}
export interface ExperienceState {
  indexing?: {
    tasks: Array<EmbeddingTask & { experienceId: string }>;
    completed: boolean;
    failure: string | null;
  };
  status: 'queued' | 'running' | 'failed' | 'completed';
  failure: string | null;
  input: ExperienceInput | null;
  attempts: ExperienceAttempt[];
  result: ExperienceResult | null;
}
export interface ExperienceGeneration {
  id: string;
  agentId: string;
  gameId: string;
  playerId: string;
  reviewVersion: string;
  state: ExperienceState;
}
export interface ExperienceStore {
  list(agentId: string): Promise<AgentExperience[]>;
  hasCandidates(scope: ExperienceScope): Promise<boolean>;
  search(
    scope: ExperienceScope,
    key: string,
    vector: number[],
    limit: number,
  ): Promise<SimilarExperience[]>;
  writeVectors(key: string, rows: Array<{ id: string; vector: number[] }>): Promise<void>;
  toggle(agentId: string, id: string, enabled: boolean): Promise<boolean>;
  findSource(
    gameId: string,
    playerId: string,
    reviewVersion: string,
  ): Promise<ExperienceGeneration | null>;
  findGeneration(id: string): Promise<ExperienceGeneration | null>;
  open(input: Omit<ExperienceGeneration, 'state'>): Promise<ExperienceGeneration>;
  /** 对照旧状态认领，重复 worker 不能同时发出同一请求。 */
  save(row: ExperienceGeneration, next: ExperienceState): Promise<void>;
  /** 结果与产物同一事务提交；零条产物也算完成。 */
  complete(row: ExperienceGeneration, result: ExperienceResult): Promise<void>;
}

export interface ExperienceScope {
  boardId: string;
  role: string;
  gameId: string;
}
export interface SimilarExperience {
  experience: AgentExperience;
  similarity: number;
}

export const initialExperienceState = (): ExperienceState => ({
  status: 'queued',
  failure: null,
  input: null,
  attempts: [],
  result: null,
});

export function experienceRows(
  row: ExperienceGeneration,
  result: ExperienceResult,
): AgentExperience[] {
  const input = row.state.input!;
  return result.experiences.map((content, index) => ({
    ...content,
    id: experienceId(row.id, index),
    agentId: row.agentId,
    agentName: input.seat.name,
    generationId: row.id,
    version: 1,
    sourceGameId: row.gameId,
    sourcePlayerId: row.playerId,
    boardId: input.boardId,
    role: input.role,
    enabled: true,
    createdAt: new Date().toISOString(),
  }));
}

function experienceId(id: string, ordinal: number) {
  const hex = createHash('sha256').update(`${id}/${ordinal}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
