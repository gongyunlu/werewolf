import { createHash } from 'node:crypto';
import type { KnowledgeContent, KnowledgeSnapshot } from '@werewolf/shared';
import type { EmbeddingTask } from '../experience/embedding-task';

export interface KnowledgeIndexState {
  status: 'draft' | 'pending' | 'ready' | 'failed' | 'unknown';
  failure: string | null;
  task?: EmbeddingTask;
}
export interface KnowledgeRevision extends KnowledgeSnapshot {
  state: KnowledgeIndexState;
  contentHash: string;
  createdAt: string;
}
export interface KnowledgeRecord {
  id: string;
  revision: number;
  activeVersionId: string | null;
  versions: KnowledgeRevision[];
}
export interface KnowledgeScope {
  boardId: string;
  role: string;
  actionType: string;
  day: number;
}
export class KnowledgeConflictError extends Error {}
export function knowledgeHash(content: KnowledgeContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
export interface KnowledgeStore {
  list(): Promise<KnowledgeRecord[]>;
  find(id: string): Promise<KnowledgeRecord | null>;
  version(id: string): Promise<KnowledgeRevision | null>;
  saveDraft(id: string, revision: number, content: KnowledgeContent): Promise<KnowledgeRecord>;
  activate(id: string, revision: number, versionId: string | null, key: string): Promise<void>;
  saveIndex(
    previous: KnowledgeRevision,
    state: KnowledgeIndexState,
    vector?: number[],
  ): Promise<void>;
  hasCandidates(scope: KnowledgeScope): Promise<boolean>;
  search(
    scope: KnowledgeScope,
    key: string,
    vector: number[],
    limit: number,
  ): Promise<
    Array<{
      knowledge: KnowledgeSnapshot;
      similarity: number;
    }>
  >;
}
