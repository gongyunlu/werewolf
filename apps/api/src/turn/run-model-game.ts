import type { GameSetup } from '../boards/setup';
import { runGame, type GameLoopResult, type StageAnchor } from '../core/loop';
import { createGameState } from '../core/state';
import type { PromptSource } from '../llm/prompt-template';
import { memoryStores } from '../store/memory';
import type { GameStores } from '../store/stores';
import type { TurnOutcome } from './graph';
import { modelActions } from './provider';
import type { TurnRuntime } from './request';

/**
 * 把一局跑完：造适配器、交给 Core 推到分出胜负。
 *
 * 提示词的来处由调用方定，整局接的都是同一个地方：图里哪条走到才取哪两条。
 */
export interface ModelGameInput {
  /** 建局快照，由 createGameSetup 发牌得到。 */
  setup: GameSetup;
  /** 玩家 id，按座位下标对齐。 */
  playerIds: readonly string[];
  /** 模型端口与逐座位的接入身份。 */
  runtime: Omit<TurnRuntime, 'promptSource'>;
  /** 提示词的来处。 */
  promptSource: PromptSource;
  /** 第 day 天发言方向的分钟数。 */
  minuteOf: (day: number) => number;
  maxDays?: number;
  /**
   * 台账、行动记录与阶段锚点写哪儿。默认是内存那几份，跑完就丢；交给它一份留得住的，
   * 同一局再跑一遍就是拿存档复算：每一问都按记录复用，不再问模型。
   */
  stores?: GameStores;
  /** 从哪一格接着跑。不给就从头开始，从头开始的那一跑与有没有存档无关。 */
  resume?: StageAnchor;
}

export interface ModelGameResult extends GameLoopResult {
  /** 每次行动的产物，按发生顺序。 */
  outcomes: readonly TurnOutcome[];
}

export async function runModelGame(input: ModelGameInput): Promise<ModelGameResult> {
  // 默认写进用完即弃的那几份：调用方不交存档过来，这一跑就没有下一段要接。
  const stores = input.stores ?? memoryStores();
  const actions = modelActions(
    { ...input.runtime, promptSource: input.promptSource },
    stores,
    input.resume?.phaseInstanceId,
  );

  const settled = await runGame({
    state: createGameState(input.setup, input.playerIds),
    actions,
    minuteOf: input.minuteOf,
    observe: actions.observe,
    // 每进一格都落一份锚点：这一跑断了，下一跑就能从断的那一格接着跑。
    onStage: actions.recordStage,
    onDayEnd: actions.judgeDayEnd,
    // 票型的定局只有 Core 有，由它交出来，适配器照记进台账。
    onBallot: (ballot) => actions.recordBallot(ballot),
    onFlow: actions.recordFlow,
    resume: input.resume,
    maxDays: input.maxDays,
  });

  await actions.recordFlow(settled.state, {
    key: 'game-over',
    phase: 'day',
    text: `对局结束，${settled.winner === 'werewolf' ? '狼人' : settled.winner === 'good' ? '好人' : '第三方'}阵营获胜。`,
  });
  return { ...settled, outcomes: actions.outcomes() };
}
