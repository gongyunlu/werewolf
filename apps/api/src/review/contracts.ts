import { z } from 'zod';
import { InvalidOutputError } from '../llm/model-port';

export const REVIEW_VERSION = 'review-v1';
export const REVIEW_STEPS = ['review_decision', 'review_player', 'review_outcome'] as const;
export type ReviewStep = (typeof REVIEW_STEPS)[number];

const ClaimSchema = z.strictObject({
  text: z.string().trim().min(1),
  refs: z.array(z.string().min(1)).min(1),
});

/** 每一项判断都带来源；没有足够证据时允许优点、问题和建议为空。 */
export const AssessmentSchema = z.strictObject({
  summary: ClaimSchema,
  strengths: z.array(ClaimSchema),
  issues: z.array(ClaimSchema),
  suggestions: z.array(ClaimSchema),
  uncertainties: z.array(ClaimSchema),
});
export type Assessment = z.infer<typeof AssessmentSchema>;
export type Claim = z.infer<typeof ClaimSchema>;

export function claimsOf(result: Assessment): { path: string; claim: Claim }[] {
  return [
    { path: 'summary', claim: result.summary },
    ...(['strengths', 'issues', 'suggestions', 'uncertainties'] as const).flatMap((key) =>
      result[key].map((claim, index) => ({ path: `${key}/${index}`, claim })),
    ),
  ];
}

export function validateReferences(result: Assessment, allowed: readonly string[]): Assessment {
  const ids = new Set(allowed);
  if (claimsOf(result).some(({ claim }) => claim.refs.some((ref) => !ids.has(ref)))) {
    throw new InvalidOutputError('复盘引用超出本次证据范围', '只能引用本次输入中的证据 id');
  }
  return result;
}
