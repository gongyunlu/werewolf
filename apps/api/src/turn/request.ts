import type { ActionType } from '@werewolf/shared';
import { z } from 'zod';
import type { ActionScope } from '../core/identity';
import type { ModelAccess, ModelPort } from '../llm/model-port';
import type { ActionPresetName } from './presets';
import type { FrozenPrompts } from './prompt';

/**
 * 这一刻该玩家看得到什么。
 * 由调用方按可见性裁剪后填进来，行动图不判可见性，也不去局里取——图只把它渲染成提示词。
 */
export interface TurnContext {
  /** 这次要他做什么，一句人话。 */
  task: string;
  /** 他自己是谁。role 写给人看，不是取值域里的串。 */
  actor: { playerId: string; seatNo: number; role: string };
  day: number;
  /** 他此刻知道的事实，按发生顺序。 */
  visible: readonly string[];
  /** 这次能选什么，来自端口方法的 candidates；只有「做/不做」两态的行动为空。 */
  options: readonly string[];
}

/** 一次行动的全部输入。 */
export interface ActionRequest {
  scope: ActionScope;
  actionType: ActionType;
  actorId: string;
  /** 同一（节点实例、事件类型、行动者）里这是第几次被问，见 actionOrdinals。 */
  actionOrdinal: number;
  preset: ActionPresetName;
  context: TurnContext;
  /** 决定的结构约束；发言没有 schema，草稿原文就是结果。 */
  schema?: z.ZodType;
}

/**
 * 一次行动的运行环境。端口、接入身份与提示词都走这里注入，不进图状态，也不进快照。
 * 提示词是整局冻好的那一份，由持有这一局的人（见 runGame）抓取后传进来。
 */
export interface TurnRuntime {
  port: ModelPort;
  access: ModelAccess;
  prompts: FrozenPrompts;
}

/**
 * 决定的结构约束转成 JSON Schema：写进提示词告诉模型要什么形状，也进冻结哈希。
 * 没有 schema 就是发言，返回 null。
 */
export function decisionSchemaJson(schema: z.ZodType | undefined): Record<string, unknown> | null {
  return schema ? (z.toJSONSchema(schema) as Record<string, unknown>) : null;
}

/**
 * 行动序号发号器：按（节点实例、事件类型、行动者）数这是第几次被问。
 * 逐段发言的自爆窗口让同一只狼在同一个节点实例里被问很多次，只按节点实例编号会撞车；
 * 一个发号器管一局，跨局复用会把序号接在上一位上。
 */
export function actionOrdinals(): (
  scope: ActionScope,
  actionType: ActionType,
  actorId: string,
) => number {
  const counts = new Map<string, number>();

  return (scope, actionType, actorId) => {
    const key = JSON.stringify([scope.phaseInstanceId, actionType, actorId]);
    const ordinal = counts.get(key) ?? 0;
    counts.set(key, ordinal + 1);
    return ordinal;
  };
}
