import {
  KnowledgeCallsSchema,
  KnowledgeItemSchema,
  KnowledgeListSchema,
  type KnowledgeContent,
} from '@werewolf/shared';
import { adminHeaders } from './admin-token';
import { http } from './http';

export const fetchKnowledge = (signal?: AbortSignal) =>
  http.get('/knowledge', { schema: KnowledgeListSchema, signal });
export const saveKnowledge = (id: string, revision: number, content: KnowledgeContent) =>
  http.put(
    `/knowledge/${id}/draft`,
    { revision, content },
    { schema: KnowledgeItemSchema, headers: adminHeaders() },
  );
export const activateKnowledge = (id: string, revision: number, versionId: string | null) =>
  http.patch(
    `/knowledge/${id}/active`,
    { revision, versionId },
    { schema: KnowledgeItemSchema, headers: adminHeaders() },
  );
export const indexKnowledge = (versionId: string) =>
  http.post(`/knowledge/versions/${versionId}/index`, undefined, {
    schema: KnowledgeItemSchema,
    headers: adminHeaders(),
  });
export const fetchKnowledgeCalls = (versionId: string) =>
  http.get(`/knowledge/versions/${versionId}/calls`, { schema: KnowledgeCallsSchema });
