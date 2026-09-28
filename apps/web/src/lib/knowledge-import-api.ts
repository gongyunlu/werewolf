import { z } from 'zod';
import {
  KnowledgeBulkResultSchema,
  KnowledgeCallsSchema,
  KnowledgeCaptureSchema,
  KnowledgeCapturesSchema,
  WebSnapshotSchema,
  type KnowledgeContent,
} from '@werewolf/shared';
import { adminHeaders } from './admin-token';
import { http } from './http';

export const fetchCaptures = (signal?: AbortSignal) =>
  http.get('/knowledge/imports', {
    schema: KnowledgeCapturesSchema,
    headers: adminHeaders(),
    signal,
  });
export const fetchCapture = (id: string) =>
  http.get(`/knowledge/imports/${id}`, { schema: KnowledgeCaptureSchema, headers: adminHeaders() });
export const fetchImportModel = () =>
  http.get('/knowledge/imports/model', {
    schema: z.object({ model: z.string() }),
    headers: adminHeaders(),
  });
export const startCapture = (batchId: string, urls: string[]) =>
  http.post(
    '/knowledge/imports',
    { batchId, urls },
    { schema: KnowledgeCapturesSchema, headers: adminHeaders() },
  );
export const retryCapture = (id: string) =>
  http.post(`/knowledge/imports/${id}/retry`, undefined, {
    schema: KnowledgeCaptureSchema,
    headers: adminHeaders(),
  });
export const organizeCapture = (
  id: string,
  selection: { revision: number; boardIds: string[]; paragraphIds: string[]; targetIds: string[] },
) =>
  http.post(`/knowledge/imports/${id}/organize`, selection, {
    schema: KnowledgeCaptureSchema,
    headers: adminHeaders(),
  });
export const confirmCandidate = (
  id: string,
  candidateId: string,
  content: KnowledgeContent,
  expectedRevision: number,
) =>
  http.put(
    `/knowledge/imports/${id}/candidates/${candidateId}`,
    { content, expectedRevision },
    { schema: KnowledgeCaptureSchema, headers: adminHeaders() },
  );
export const discardCandidate = (id: string, candidateId: string) =>
  http.post(`/knowledge/imports/${id}/candidates/${candidateId}/discard`, undefined, {
    schema: KnowledgeCaptureSchema,
    headers: adminHeaders(),
  });
export const fetchCaptureCalls = (id: string) =>
  http.get(`/knowledge/imports/${id}/calls`, {
    schema: KnowledgeCallsSchema,
    headers: adminHeaders(),
  });
export const fetchSourceSnapshot = (id: string, signal?: AbortSignal) =>
  http.get(`/knowledge/sources/${id}`, { schema: WebSnapshotSchema, signal });
export const bulkKnowledgeAction = (
  operation: 'index' | 'activate',
  items: Array<{ id: string; versionId: string; revision: number }>,
) =>
  http.post(
    '/knowledge/imports/actions',
    { operation, items },
    { schema: KnowledgeBulkResultSchema, headers: adminHeaders() },
  );
