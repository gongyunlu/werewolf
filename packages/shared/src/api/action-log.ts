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
});

export type ActionLogEntry = z.infer<typeof ActionLogEntrySchema>;

export const ActionLogResponseSchema = z.object({
  actions: z.array(ActionLogEntrySchema),
});

export type ActionLogResponse = z.infer<typeof ActionLogResponseSchema>;
