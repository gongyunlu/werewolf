import { z } from 'zod';
import { KnowledgeContentSchema } from './knowledge';

export const WebSnapshotSchema = z.object({
  url: z.url(),
  title: z.string(),
  publisher: z.string(),
  author: z.string(),
  publishedOn: z.iso.date().nullable(),
  fetchedAt: z.string(),
  hash: z.string(),
  paragraphs: z.array(z.object({ id: z.string(), text: z.string() })),
});
export const KnowledgeCandidateSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  before: KnowledgeContentSchema.nullable(),
  content: KnowledgeContentSchema,
  status: z.enum(['pending', 'saved', 'discarded']),
  versionId: z.uuid().nullable(),
});
export const KnowledgeCaptureSchema = z.object({
  id: z.uuid(),
  batchId: z.uuid(),
  sourceId: z.uuid(),
  url: z.url(),
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  status: z.enum(['queued', 'fetching', 'ready', 'unchanged', 'failed']),
  failure: z.string().nullable(),
  previousId: z.uuid().nullable(),
  snapshot: WebSnapshotSchema.nullable(),
  candidates: z.array(KnowledgeCandidateSchema),
  organization: z
    .object({
      status: z.enum(['queued', 'running', 'ready', 'failed', 'unknown']),
      failure: z.string().nullable(),
      model: z.string(),
      boardIds: z.array(z.string()),
      paragraphIds: z.array(z.string()),
      targetIds: z.array(z.string()),
      reason: z.string().nullable(),
      calls: z.array(z.object({ callId: z.string(), status: z.string() })),
    })
    .nullable(),
});
export const KnowledgeCapturesSchema = z.object({ captures: z.array(KnowledgeCaptureSchema) });
export const KnowledgeCaptureStartSchema = z
  .object({
    batchId: z.uuid(),
    urls: z.array(z.url().max(600)).min(1).max(20),
  })
  .strict();
export const KnowledgeOrganizeSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    boardIds: z.array(z.string()).min(1).max(3),
    paragraphIds: z
      .array(z.string().regex(/^P\d+$/))
      .min(1)
      .max(100),
    targetIds: z.array(z.uuid()).max(5),
  })
  .strict();
export const KnowledgeCandidateSaveSchema = z
  .object({
    content: KnowledgeContentSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const KnowledgeBulkActionSchema = z
  .object({
    operation: z.enum(['index', 'activate']),
    items: z
      .array(
        z
          .object({
            id: z.uuid(),
            versionId: z.uuid(),
            revision: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const KnowledgeBulkResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.uuid(),
      versionId: z.uuid(),
      error: z.string().nullable(),
    }),
  ),
});
export type WebSnapshot = z.infer<typeof WebSnapshotSchema>;
export type KnowledgeCandidate = z.infer<typeof KnowledgeCandidateSchema>;
export type KnowledgeCapture = z.infer<typeof KnowledgeCaptureSchema>;
