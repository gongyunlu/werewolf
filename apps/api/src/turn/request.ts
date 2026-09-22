import type { ActionType } from '@werewolf/shared';
import { z } from 'zod';
import { actionKey, type ActionScope } from '../core/identity';
import type { ModelAccess, ModelPort } from '../llm/model-port';
import type { PromptSource } from '../llm/prompt-template';
import type { GameSkills } from '../skills/game-skills';
import type { ActionPresetName } from './presets';

/**
 * 一块事实：一个小标题加它底下的几行。
 *
 * 分块是为了让模型一眼看出「这是公开发言」「这是狼队商议」「这是票型」，
 * 而不是从一个平铺的列表里靠每行开头那几个字去猜。块内的 `【第 N 天】` 分隔行自带括号，
 * 渲染时不再给它加项目符号。
 */
export interface FactBlock {
  title: string;
  lines: readonly string[];
}

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
  /** 他此刻知道的事实，按块排；空块不留。 */
  visible: readonly FactBlock[];
  /** 这次能选什么，来自端口方法的 candidates；只有「做/不做」两态的行动为空。 */
  options: readonly string[];
  /**
   * 这一问要带上的技能正文，按「板子 → 角色 → 场景」排，缺哪一段就少哪一段。
   * 每问都带一份，带上之后它就是这次提问实打实的输入。
   */
  skill: readonly string[];
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

/** 一次提问的行动键：请求里那几项合起来就是它的身份，台账、提交记录与快照都按它认人。 */
export function actionKeyOf(request: ActionRequest): string {
  return actionKey(request.scope, request.actionType, request.actorId, request.actionOrdinal);
}

/**
 * 一次行动的运行环境。端口、接入身份与提示词都走这里注入，不进图状态，也不进快照。
 * 提示词给的是取用口子而不是取好的正文：图里哪个节点走到才取哪两条。
 */
export interface TurnRuntime {
  port: ModelPort;
  access: ModelAccess;
  /** 提示词的来处。图里哪条走到才取哪两条，取到的 production 版本是什么就是什么。 */
  promptSource: PromptSource;
  /** 这一局的技能正文，由持有这一局的人按板子取一次，整局共用。 */
  skills: GameSkills;
}

/**
 * 决定的结构约束转成 JSON Schema：写进快照留档，也用来拼这次行动的工具定义。
 * 没有 schema 就是发言，返回 null。
 */
export function decisionSchemaJson(schema: z.ZodType | undefined): Record<string, unknown> | null {
  return schema ? (z.toJSONSchema(schema) as Record<string, unknown>) : null;
}

/**
 * 行动序号发号器：按（节点实例、事件类型、行动者）数这是第几次被问。
 * 同一天最多问同一只狼两回（竞选那天多一次），只按节点实例编号会撞车；
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
