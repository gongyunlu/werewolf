import type { PromptSource } from '../llm/prompt-template';
import type { RandomSource } from '../boards/deal';
import type { GameSetup } from '../boards/setup';
import { runGame, type GameLoopResult } from '../core/loop';
import { createGameState } from '../core/state';
import type { TurnOutcome } from './graph';
import { freezeTurnPrompts, type FrozenPrompts } from './prompt';
import { modelActions } from './provider';
import type { TurnRuntime } from './request';

/**
 * 把一局跑完：冻提示词、造适配器、交给 Core 从头推到分出胜负。
 *
 * 提示词只在这里冻一次，整局共用那一份——平台改版、网络断了，局中换正文都算换了输入，
 * 而这局的每一次决定都要能按同一份输入复算出来。
 */
export interface ModelGameInput {
  /** 建局快照，由 createGameSetup 发牌得到。 */
  setup: GameSetup;
  /** 玩家 id，按座位下标对齐。 */
  playerIds: readonly string[];
  /** 模型端口与接入身份；提示词由本函数自己冻。 */
  runtime: Omit<TurnRuntime, 'prompts'>;
  /** 提示词源。平台整份取不到时整局走本地兜底那份。 */
  promptSource: PromptSource;
  /** 狼队提刀并列、发牌用的随机源。 */
  random: RandomSource;
  /** 第 day 天发言方向的分钟数。 */
  minuteOf: (day: number) => number;
  maxDays?: number;
}

export interface ModelGameResult extends GameLoopResult {
  /** 整局冻住的那六条提示词。 */
  prompts: FrozenPrompts;
  /** 每次行动的产物，按发生顺序。 */
  outcomes: readonly TurnOutcome[];
}

export async function runModelGame(input: ModelGameInput): Promise<ModelGameResult> {
  const prompts = await freezeTurnPrompts(input.promptSource);
  const actions = modelActions({ ...input.runtime, prompts });

  const settled = await runGame({
    state: createGameState(input.setup, input.playerIds),
    actions,
    random: input.random,
    minuteOf: input.minuteOf,
    observe: actions.observe,
    maxDays: input.maxDays,
  });

  return { ...settled, prompts, outcomes: actions.outcomes() };
}
