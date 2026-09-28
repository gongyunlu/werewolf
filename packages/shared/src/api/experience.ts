import { z } from 'zod';
import { ReviewSourceSchema } from './review';

export const ExperienceContentSchema = z.object({
  title: z.string().trim().min(1).max(64),
  body: z.string().trim().min(1).max(600),
  conditions: z.string().trim().min(1).max(240),
  sourceIds: z.array(z.string()).min(1).max(6),
});
export const ExperienceResultSchema = z.object({
  experiences: z.array(ExperienceContentSchema).max(3),
  reason: z.string().max(400),
});
export const ExperienceSnapshotSchema = ExperienceContentSchema.extend({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string().optional(),
  version: z.number().int().positive(),
  generationId: z.string(),
  sourceGameId: z.string(),
  sourcePlayerId: z.string(),
  boardId: z.string(),
  role: z.string(),
});
export const AgentExperienceSchema = ExperienceSnapshotSchema.extend({
  enabled: z.boolean(),
  indexed: z.boolean().optional(),
  archived: z.boolean().optional(),
  revision: z.number().int().nonnegative().optional(),
  history: z.array(ExperienceSnapshotSchema).optional(),
  indexStatus: z.enum(['draft', 'pending', 'ready', 'failed', 'unknown']).optional(),
  indexFailure: z.string().nullable().optional(),
  indexModel: z.string().nullable().optional(),
  indexCalls: z.array(z.object({ callId: z.string(), status: z.string() })).optional(),
  createdAt: z.string(),
});
export const ExperienceListSchema = z.object({ experiences: z.array(AgentExperienceSchema) });
export const ExperienceToggleSchema = z
  .object({
    enabled: z.boolean(),
    revision: z.number().int().nonnegative().optional(),
  })
  .strict();
export const ExperienceEditableSchema = ExperienceContentSchema.pick({
  title: true,
  body: true,
  conditions: true,
}).strict();
export const ExperienceEditSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    content: ExperienceEditableSchema,
  })
  .strict();
export const ExperienceArchiveSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    archived: z.boolean(),
  })
  .strict();
export const ExperienceIndexSchema = z.object({ version: z.number().int().positive() }).strict();
export type ExperienceEditable = z.infer<typeof ExperienceEditableSchema>;
export const ExperienceSourceSchema = ReviewSourceSchema.extend({
  perspective: z.enum(['at_action', 'post_game']),
});
export const ExperienceGenerationSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  sourceGameId: z.string(),
  sourcePlayerId: z.string(),
  reviewVersion: z.string(),
  status: z.string(),
  failure: z.string().nullable(),
  result: ExperienceResultSchema.nullable(),
  sources: z.array(ExperienceSourceSchema),
  prompts: z
    .array(z.object({ name: z.string(), version: z.number().nullable(), source: z.string() }))
    .optional(),
  calls: z.array(
    z.object({
      callId: z.string(),
      status: z.string(),
    }),
  ),
});
export const ExperienceGenerationResponseSchema = z.object({
  status: z.string(),
  reason: z.string().nullable(),
  generation: ExperienceGenerationSchema.nullable(),
});
export const ExperienceCallInputSchema = z.object({
  callId: z.string(),
  step: z.string(),
  dispatched: z.boolean(),
  experiences: z.array(ExperienceSnapshotSchema),
});
export const ExperienceRetrievalSchema = z.object({
  status: z.enum(['pending', 'failed', 'completed']),
  query: z.string(),
  model: z.string().nullable(),
  failure: z.string().nullable(),
  candidates: z.array(z.object({ id: z.string(), similarity: z.number() })),
  selected: z.array(ExperienceSnapshotSchema),
});
export type ExperienceRetrieval = z.infer<typeof ExperienceRetrievalSchema>;
export type ExperienceContent = z.infer<typeof ExperienceContentSchema>;
export type ExperienceResult = z.infer<typeof ExperienceResultSchema>;
export type ExperienceSnapshot = z.infer<typeof ExperienceSnapshotSchema>;
export type AgentExperience = z.infer<typeof AgentExperienceSchema>;
export type ExperienceSource = z.infer<typeof ExperienceSourceSchema>;
export type ExperienceGenerationResponse = z.infer<typeof ExperienceGenerationResponseSchema>;
export type ExperienceCallInput = z.infer<typeof ExperienceCallInputSchema>;
