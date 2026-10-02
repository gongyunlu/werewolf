import {
  ExperienceSnapshotSchema,
  type AgentExperience,
  type ExperienceEditable,
  type ExperienceResult,
  type ExperienceSource,
} from '@werewolf/shared';
import type { EmbeddingTask } from '../experience/embedding-task';
import type { ModelResponse } from '../llm/model-port';
import type { PromptTemplate } from '../prompts/template';
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
  find(id: string): Promise<ExperienceRecord | null>;
  edit(
    agentId: string,
    id: string,
    revision: number,
    content: ExperienceEditable,
  ): Promise<boolean>;
  archive(agentId: string, id: string, revision: number, archived: boolean): Promise<boolean>;
  saveIndex(
    previous: ExperienceRecord,
    state: ExperienceIndexState,
    vector?: number[],
  ): Promise<void>;
  hasCandidates(scope: ExperienceScope): Promise<boolean>;
  search(
    scope: ExperienceScope,
    key: string,
    vector: number[],
    limit: number,
  ): Promise<SimilarExperience[]>;
  writeVectors(key: string, rows: Array<{ id: string; vector: number[] }>): Promise<void>;
  toggle(
    agentId: string,
    id: string,
    enabled: boolean,
    revision?: number,
    key?: string,
  ): Promise<boolean>;
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

export class ExperienceConflictError extends Error {}
export interface ExperienceIndexState {
  status: 'draft' | 'pending' | 'ready' | 'failed' | 'unknown';
  failure: string | null;
  task?: EmbeddingTask;
}
export interface ExperienceRecord {
  item: AgentExperience;
  state: ExperienceIndexState | null;
  embeddingKey: string | null;
}
export function checkExperienceRevision(item: AgentExperience, revision: number | undefined) {
  if (revision !== undefined && (item.revision ?? 0) !== revision)
    throw new ExperienceConflictError('经验已被修改，请刷新后重试');
}
export function editedExperience(
  item: AgentExperience,
  content: ExperienceEditable,
): AgentExperience {
  if (item.archived) throw new ExperienceConflictError('请先恢复归档经验，再编辑');
  if (
    item.title === content.title &&
    item.body === content.body &&
    item.conditions === content.conditions
  )
    return item;
  return {
    ...item,
    ...content,
    version: item.version + 1,
    revision: (item.revision ?? 0) + 1,
    history: [...(item.history ?? []), ExperienceSnapshotSchema.parse(item)],
    enabled: false,
    indexed: false,
  };
}
export function checkExperienceEnable(row: ExperienceRecord, enabled: boolean, key?: string) {
  if (row.item.archived) throw new ExperienceConflictError('归档经验不能启停，请先恢复');
  if (
    enabled &&
    row.item.version > 1 &&
    (row.state?.status !== 'ready' || !row.item.indexed || !key || row.embeddingKey !== key)
  )
    throw new ExperienceConflictError('请先完成此版本在当前向量接入下的索引，再启用');
}
export function experienceIndexView(state: ExperienceIndexState | null, indexed: boolean) {
  return {
    indexStatus: state?.status ?? (indexed ? 'ready' : 'draft'),
    indexFailure: state?.failure ?? null,
    indexModel: state?.task?.model ?? null,
    indexCalls: state?.task?.attempts.map(({ callId, status }) => ({ callId, status })) ?? [],
  };
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
    archived: false,
    revision: 0,
    history: [],
    createdAt: new Date().toISOString(),
  }));
}

function experienceId(id: string, ordinal: number) {
  const hex = createHash('sha256').update(`${id}/${ordinal}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
