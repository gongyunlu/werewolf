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
