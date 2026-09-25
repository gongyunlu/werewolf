import { ACTION_TYPES, type ActionType } from '@werewolf/shared';

/** 行动档位名。 */
export type ActionPresetName = 'quality' | 'quick';

/**
 * 一次行动的档位。
 * 两档的权限、必需输入和校验完全同一份，差别只在生成之后要不要再问一次独立质疑。
 */
export interface ActionPreset {
  name: ActionPresetName;
  /** 为真才走质疑与修订；为假是生成完就交。 */
  critique: boolean;
}

export const ACTION_PRESETS: Readonly<Record<ActionPresetName, ActionPreset>> = {
  quality: { name: 'quality', critique: true },
  quick: { name: 'quick', critique: false },
};

/**
 * 走 quick 的行动类型；不在表里的一律 quality。
 * 二态、发言方向和日终主观判断直接提交，不增加内容复核调用。
 * 发言反而最值得审——一段话站不站得住，是这局里唯一没法靠形状卡住的东西。
 * 新加的行动类型默认落到 quality，是往严的那边倒，不用再有人来记着补一笔。
 */
const QUICK_ACTIONS: readonly ActionType[] = [
  // 日终判断只校验格式，不按策略偏好质疑和改写。
  ACTION_TYPES.DAY_END_JUDGMENT,
  ACTION_TYPES.SHERIFF_CANDIDACY,
  ACTION_TYPES.SHERIFF_WITHDRAW,
  ACTION_TYPES.WOLF_EXPLODE,
  ACTION_TYPES.WOLF_DISCUSSION_CONTINUE,
  ACTION_TYPES.SHERIFF_DECIDE_ORDER,
];

/** 这次行动走哪一档。 */
export function presetOf(actionType: ActionType): ActionPresetName {
  return QUICK_ACTIONS.includes(actionType) ? 'quick' : 'quality';
}
