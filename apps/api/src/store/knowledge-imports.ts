import type {
  KnowledgeCandidate,
  KnowledgeCapture,
  KnowledgeContent,
  WebSnapshot,
} from '@werewolf/shared';
import type { ModelResponse } from '../llm/model-port';
import type { PromptTemplate } from '../llm/prompt-template';
import { KnowledgeConflictError, type KnowledgeRecord } from './knowledge';

export interface OrganizationInput {
  boardIds: string[];
  paragraphIds: string[];
  targets: Array<{ id: string; revision: number; content: KnowledgeContent }>;
  prompts: PromptTemplate[];
  model: string;
  endpointKey: string;
  rules: Array<{ id: string; text: string }>;
}
export interface OrganizationState {
  status: 'queued' | 'running' | 'ready' | 'failed' | 'unknown';
  failure: string | null;
  reason: string | null;
  input: OrganizationInput;
  attempts: Array<{
    callId: string;
    status: 'pending' | 'responded' | 'failed' | 'invalid' | 'accepted';
    response?: Pick<ModelResponse, 'content' | 'toolCall' | 'reasoning'>;
    durationMs?: number;
  }>;
}
export interface CaptureState {
  status: KnowledgeCapture['status'];
  failure: string | null;
  previousId: string | null;
  snapshot: WebSnapshot | null;
  organization: OrganizationState | null;
  candidates: KnowledgeCandidate[];
}
export interface CaptureRecord {
  id: string;
  batchId: string;
  sourceId: string;
  url: string;
  revision: number;
  createdAt: string;
  state: CaptureState;
}
export const initialCaptureState = (): CaptureState => ({
  status: 'queued',
  failure: null,
  previousId: null,
  snapshot: null,
  organization: null,
  candidates: [],
});
export interface KnowledgeImportStore {
  open(batchId: string, urls: string[]): Promise<CaptureRecord[]>;
  list(): Promise<CaptureRecord[]>;
  find(id: string): Promise<CaptureRecord | null>;
  previous(row: CaptureRecord): Promise<CaptureRecord | null>;
  save(row: CaptureRecord, state: CaptureState): Promise<CaptureRecord>;
  confirm(
    id: string,
    candidateId: string,
    content: KnowledgeContent,
    expectedRevision: number,
  ): Promise<CaptureRecord>;
  discard(id: string, candidateId: string): Promise<CaptureRecord>;
}
export function requireCandidate(row: CaptureRecord, id: string) {
  const candidate = row.state.candidates.find((item) => item.id === id);
  if (!candidate) throw new KnowledgeConflictError('没有这条候选');
  return candidate;
}
export function confirmedCandidate(
  candidate: KnowledgeCandidate,
  item: KnowledgeRecord,
): KnowledgeCandidate {
  const latest = item.versions.at(-1)!;
  return { ...candidate, status: 'saved', content: latest.content, versionId: latest.versionId };
}
