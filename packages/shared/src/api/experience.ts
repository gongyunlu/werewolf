import { z } from 'zod';
import { RetrievalCandidateDiagnosticsSchema } from './retrieval';
import { ReviewSourceSchema } from './review';
import { KNOWLEDGE_ACTION_TYPES } from './knowledge';

export const ExperienceContentSchema = z.object({
  title: z.string().trim().min(1).max(64),
  body: z.string().trim().min(1).max(600),
  conditions: z.string().trim().min(1).max(240),
  sourceIds: z.array(z.string()).min(1).max(6),
  actionTypes: z.array(z.enum(KNOWLEDGE_ACTION_TYPES)).min(1).max(12).optional(),
  minDay: z.number().int().min(1).max(20).optional(),
  firstDayOnly: z.boolean().optional(),
  exclusions: z.string().trim().min(1).max(240).optional(),
});
const scopeFields = {
  actionTypes: true,
  minDay: true,
  firstDayOnly: true,
  exclusions: true,
} as const;
const validateScope = (
  value: { actionTypes: string[]; minDay: number; firstDayOnly: boolean },
  ctx: z.RefinementCtx,
) => {
  if (value.firstDayOnly && value.minDay !== 1)
    ctx.addIssue({ code: 'custom', path: ['minDay'], message: '仅首日与最早适用天数冲突' });
  if (new Set(value.actionTypes).size !== value.actionTypes.length)
    ctx.addIssue({ code: 'custom', path: ['actionTypes'], message: '适用行动不能重复' });
};
export const ExperienceCandidateContentSchema =
  ExperienceContentSchema.required(scopeFields).superRefine(validateScope);
export const ExperienceResultSchema = z.object({
  experiences: z.array(ExperienceContentSchema).max(3),
  reason: z.string().max(400),
});
export const ExperienceCandidateResultSchema = ExperienceResultSchema.extend({
  experiences: z.array(ExperienceCandidateContentSchema).max(3),
});
export const ExperienceReviewSchema = z.object({
  version: z.number().int().positive(),
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().min(1).max(600),
  sourceIds: z.array(z.string()).min(1).max(6),
  reviewedAt: z.iso.datetime(),
});
export const ExperienceReviewRequestSchema = ExperienceReviewSchema.omit({ reviewedAt: true })
  .extend({ revision: z.number().int().nonnegative() })
  .strict();
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
  reviews: z.array(ExperienceReviewSchema).optional(),
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
  ...scopeFields,
})
  .required(scopeFields)
  .strict()
  .superRefine(validateScope);
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
export const ExperienceAuditSchema = z.object({
  experience: AgentExperienceSchema,
  sources: z.array(ExperienceSourceSchema),
  related: z.array(
    z.object({
      experience: ExperienceSnapshotSchema,
      reason: z.enum(['duplicate', 'overlapping_scope']),
    }),
  ),
});
export type ExperienceReview = z.infer<typeof ExperienceReviewSchema>;
export type ExperienceReviewRequest = z.infer<typeof ExperienceReviewRequestSchema>;
export type ExperienceAudit = z.infer<typeof ExperienceAuditSchema>;
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
  candidates: z.array(
    RetrievalCandidateDiagnosticsSchema.extend({ id: z.string(), similarity: z.number() }),
  ),
  selected: z.array(ExperienceSnapshotSchema),
  mode: z.enum(['none', 'vector', 'hybrid']).optional(),
  policyVersion: z.string().optional(),
  rerankModel: z.string().optional(),
  minRelevance: z.number().optional(),
});
export type ExperienceRetrieval = z.infer<typeof ExperienceRetrievalSchema>;
export type ExperienceContent = z.infer<typeof ExperienceContentSchema>;
export type ExperienceResult = z.infer<typeof ExperienceResultSchema>;
export type ExperienceSnapshot = z.infer<typeof ExperienceSnapshotSchema>;
export type AgentExperience = z.infer<typeof AgentExperienceSchema>;
export type ExperienceSource = z.infer<typeof ExperienceSourceSchema>;
export type ExperienceGenerationResponse = z.infer<typeof ExperienceGenerationResponseSchema>;
export type ExperienceCallInput = z.infer<typeof ExperienceCallInputSchema>;
