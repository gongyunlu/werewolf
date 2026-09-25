import { z } from 'zod';

/** 局内个人判断，不代表系统确认的事实。 */
export const DayEndJudgmentSchema = z.object({
  assessment: z.string().trim().min(1).max(1600),
  changes: z.string().trim().max(600),
});
export type DayEndJudgment = z.infer<typeof DayEndJudgmentSchema>;

/** 只携带最近一份判断，来源与信息截止位置随行动快照保存。 */
export const PreviousJudgmentSchema = DayEndJudgmentSchema.extend({
  actionKey: z.string(),
  day: z.number().int().positive(),
  ledgerSeq: z.number().int().nonnegative(),
});
export type PreviousJudgment = z.infer<typeof PreviousJudgmentSchema>;
