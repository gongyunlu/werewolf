import type { ActionType } from '@werewolf/shared';
import type { z } from 'zod';
import type { ModelCapability } from '../llm/model-capability';
import type { CRITIQUE_SCHEMA, RenderedPrompt } from './prompt';
import type { ActionPresetName } from './presets';
import type { TurnContext } from './request';

/** 质疑一次的结论。形状跟着解析用的那份 schema 走，不另外抄一遍。 */
export type Critique = z.infer<typeof CRITIQUE_SCHEMA>;

/**
 * 决定快照：这次决定是怎么来的。
 * 端点与密钥不在这里——它们属于接入身份，不属于决定；轮换一次密钥不该让旧记录失真。
 */
export interface DecisionSnapshot {
  /** 最终采用的生成或修订调用；旧记录未知，不根据时间顺序猜。 */
  sourceCallId?: string | null;
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
  /** 这次运行实际渲染出来的提示词，按渲染顺序，记着各自取到的是哪一版。 */
  prompts: readonly RenderedPrompt[];
  /** 最终采用的那份草稿原文。 */
  draft: string;
  /** 走过质疑才有；quick 档为 null。 */
  critique: Critique | null;
  /** 校验过的结果；发言就是草稿原文。 */
  decision: unknown;
  /** 最终那版决定之前模型自己那段推理，原文；端点没给（思考关着）就是 null。 */
  reasoning: string | null;
  /** 生成、复核、修订及格式重试的推理输出耗时总和。旧记录没有此项。 */
  thinkingMs?: number | null;
  /** 这一趟里模型交歪了几回（0 = 每一问都一次交对）。是那三问的合计，分不出是哪一问歪的。 */
  retries: number;
}
