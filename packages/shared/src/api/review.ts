import { z } from 'zod';

export const ReviewSourceSchema = z.object({
  id: z.string(),
  origin: z.union([
    z.object({ actionKey: z.string(), path: z.string() }),
    z.object({ seq: z.number() }),
    z.object({ path: z.string() }),
  ]),
  value: z.unknown(),
});
const ReviewGapSchema = z.object({
  actorId: z.string(),
  actionKey: z.string(),
  reason: z.string(),
});
const ReviewTargetSchema = z.object({
  actionKey: z.string(),
  actorId: z.string(),
  actionType: z.string(),
  sources: z.array(ReviewSourceSchema),
});
export const ReviewAnalysisSchema = z.object({
  text: z.string(),
  references: z.array(z.object({ label: z.string(), sourceId: z.string() })),
});
export const ReviewUnitSchema = z.object({
  key: z.string(),
  step: z.enum(['review_decision', 'review_player', 'review_outcome']),
  sources: z.array(ReviewSourceSchema),
  result: ReviewAnalysisSchema.nullable(),
});
export const ReviewPreviewSchema = z.object({
  decisions: z.number(),
  players: z.number(),
  gaps: z.array(ReviewGapSchema),
  expectedLogicalCalls: z.number(),
  evidenceCharacters: z.object({ decisions: z.number(), omniscient: z.number() }),
  note: z.string(),
});
export const ReviewReportSchema = z.object({
  evidence: z.object({
    gameId: z.string(),
    players: z.array(z.object({ id: z.string(), seatNo: z.number() })),
    targets: z.array(ReviewTargetSchema),
    gaps: z.array(ReviewGapSchema),
  }),
  version: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  units: z.array(ReviewUnitSchema),
  players: z.array(
    z.object({
      playerId: z.string(),
      evaluatedDecisions: z.number(),
      result: ReviewAnalysisSchema.nullable(),
      limitation: z.string().nullable(),
    }),
  ),
  outcome: ReviewAnalysisSchema.nullable(),
});
// 队列还可能返回暂停、延迟等状态，保留原值供页面识别，不能误当成未开始。
export const ReviewStartResponseSchema = z.object({ status: z.string() });
export const ReviewResponseSchema = ReviewStartResponseSchema.extend({
  report: ReviewReportSchema.nullable(),
  failure: z.string().nullable(),
});

export type ReviewSource = z.infer<typeof ReviewSourceSchema>;
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;
export type ReviewAnalysis = z.infer<typeof ReviewAnalysisSchema>;
export type ReviewUnit = z.infer<typeof ReviewUnitSchema>;
export type ReviewPreview = z.infer<typeof ReviewPreviewSchema>;
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;
