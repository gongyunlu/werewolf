import { z } from 'zod';

export const RetrievalCandidateDiagnosticsSchema = z.object({
  keywordScore: z.number().optional(),
  vectorRank: z.number().optional(),
  keywordRank: z.number().optional(),
  fusionScore: z.number().optional(),
  rerankScore: z.number().optional(),
  applicable: z.boolean().optional(),
  reason: z.string().optional(),
  rejection: z.enum(['inapplicable', 'irrelevant', 'duplicate', 'budget']).nullable().optional(),
  duplicateOf: z.string().nullable().optional(),
});
