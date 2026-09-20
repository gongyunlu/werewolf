import { createHash } from 'node:crypto';
import type { ActionType } from '@werewolf/shared';
import type { z } from 'zod';
import { canonicalJson } from '../llm/canonical-json';
import type { ModelCapability } from '../llm/model-capability';
import type { PromptTemplate } from '../llm/prompt-template';
import type { CRITIQUE_SCHEMA, RenderedPrompt } from './prompt';
import type { ActionPresetName } from './presets';
import type { TurnContext } from './request';

/** 质疑一次的结论。形状跟着解析用的那份 schema 走，不另外抄一遍。 */
export type Critique = z.infer<typeof CRITIQUE_SCHEMA>;

/**
 * 冻结快照：这次决定是怎么来的。
 * 端点与密钥不在这里——它们属于接入身份，不属于决定；轮换一次密钥不该让旧记录失真。
 * 型号要记：能力是从它推出来的，只留能力的话，一份存档看不出是哪台机器答的，也算不回它自己那个哈希。
 */
export interface DecisionSnapshot {
  actionKey: string;
  actionType: ActionType;
  actorId: string;
  actionOrdinal: number;
  preset: ActionPresetName;
  model: string;
  capability: ModelCapability;
  context: TurnContext;
  /** 决定的结构约束；发言为 null。 */
  schema: Record<string, unknown> | null;
  /** 这次运行实际渲染出来的提示词，按渲染顺序。 */
  prompts: readonly RenderedPrompt[];
  inputHash: string;
  /** 最终采用的那份草稿原文。 */
  draft: string;
  /** 走过质疑才有；quick 档为 null。 */
  critique: Critique | null;
  /** 校验过的结果；发言就是草稿原文。 */
  decision: unknown;
}

/**
 * 参与哈希的部分：这次的输入，加上整局冻住的那六条模板。产物与接入身份不在里面。
 *
 * 型号要进：能力是从型号推出来的，两个能力声明恰好相同的型号只哈希能力就会算出同一个值，
 * 而同一个输入换个型号答出来的东西不一样，那时哈希就不是这份决定的标记了。
 */
export interface DecisionHashSource {
  actionKey: string;
  actionType: ActionType;
  actionOrdinal: number;
  preset: ActionPresetName;
  model: string;
  capability: ModelCapability;
  context: TurnContext;
  schema: Record<string, unknown> | null;
  /** 正文也进哈希，不是只哈希版本号：正文才是真正的输入，版本号只是它的标记。 */
  prompts: readonly PromptTemplate[];
}

/**
 * 冻结输入哈希。
 * 输入一模一样的两次运行必须算出同一个值，所以先过 canonicalJson 排序键再吃 sha256。
 */
export function decisionInputHash(source: DecisionHashSource): string {
  return createHash('sha256').update(canonicalJson(source)).digest('hex');
}
