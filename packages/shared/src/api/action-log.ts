import { z } from 'zod';
import { ACTION_TYPES } from '../domain/action-types';

/** 一条行动记录里前端要用的那几项：谁、哪天、问的什么、定了什么、为什么。 */
export const ActionLogEntrySchema = z.object({
  actionKey: z.string(),
  actionType: z.enum(Object.values(ACTION_TYPES)),
  day: z.number(),
  seatNo: z.number(),
  /** 角色写给人看，不是取值域里的串（同 TurnContext.actor.role）。 */
  role: z.string(),
  task: z.string(),
  /** 决定本身，形状由这次行动的类型定；发言就是一段原文。座位号是局内的号，不是玩家标识。 */
  decision: z.unknown(),
  /** 定下它之前模型自己那段推理；没留的那几问是 null。 */
  reasoning: z.string().nullable(),
  thinkingMs: z.number().nonnegative().nullable().optional(),
});

export type ActionLogEntry = z.infer<typeof ActionLogEntrySchema>;

export const ActionLogResponseSchema = z.object({
  actions: z.array(ActionLogEntrySchema),
});

export type ActionLogResponse = z.infer<typeof ActionLogResponseSchema>;

/** 列表不传长篇思考，展开行动时再读取。 */
export const ActionSummarySchema = ActionLogEntrySchema.omit({ reasoning: true }).extend({
  ledgerSeq: z.number(),
  hasReasoning: z.boolean(),
  /** 来自实际执行阶段，不能用台账水位推算昼夜。 */
  phase: z.string(),
  /** 这次行动产生的事实行；没有产生事实时为 null。 */
  eventSeq: z.number().nullable(),
});
export type ActionSummary = z.infer<typeof ActionSummarySchema>;
export const PendingActionSchema = ActionLogEntrySchema.pick({
  actionKey: true,
  actionType: true,
}).extend({ actorId: z.string() });
export type PendingAction = z.infer<typeof PendingActionSchema>;
export const ActionSummaryResponseSchema = z.object({
  actions: z.array(ActionSummarySchema),
  pending: z.array(PendingActionSchema),
});

export const ActionStepSchema = z.object({
  thinkingMs: z.number().nonnegative().nullable().optional(),
  id: z.string(),
  name: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  content: z.string(),
  reasoning: z.string().nullable(),
});
export type ActionStep = z.infer<typeof ActionStepSchema>;
export const ActionDetailResponseSchema = z.object({
  reasoning: z.string().nullable(),
  steps: z.array(ActionStepSchema),
});
export type ActionDetailResponse = z.infer<typeof ActionDetailResponseSchema>;
