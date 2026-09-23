import type { ActionProvider } from '../actions';
import { seatNames, type FlowObserver } from '../flow';
import { daySpeechOrder, sheriffSpeechOrder } from '../speech-order';
import type { GameState } from '../state';
import { settleBadgeAfterDeaths } from './badge';
import { runSheriffElection } from './election';
import { runExile } from './exile';
import type { Ballot, BallotObserver } from '../vote';
import { runBlastWindow } from './self-destruct';
import { speakInOrder, type Speech } from './speech';

export interface DayInput {
  /** 天亮那段走完后的状态：死讯落了地，出局技能也结算完了。 */
  state: GameState;
  actions: ActionProvider;
  /** 当前时间的分钟数，用来算发言顺序。 */
  minute: number;
  /**
   * 交出现当局面的口子，见 GameLoopInput.observe。
   * 白天在这儿补交一次：竞选选出的警长、自爆带走的人都落在白天内部，
   * 后面还有一大串提问，只给入场时那份等于让人拿着过期的局面答。
   */
  observe?: (state: GameState) => void;
  onBallot?: BallotObserver;
  onFlow?: FlowObserver;
}

/** 一个白天走完之后的全部结果。 */
export interface DayResult {
  state: GameState;
  /** 按实际发生顺序排的全部发言，含警上、白天常规与 PK 三轮。 */
  speeches: Speech[];
  /** 被放逐的玩家；无人出局、当天被自爆打断，都是 null。 */
  exiledId: string | null;
  /** 今天投过的每一轮，按先后；没走到投票就是空的。 */
  ballots: readonly Ballot[];
}

/**
 * 走完一个白天：警长竞选 → 警徽处理 → 自爆窗口 → 发言 → 投票 → 平票 PK → 放逐。
 *
 * 死讯公布和出局技能的结算不在这里：它们每走一步都可能分出胜负，得让外层在中间停下来判。
 * 放逐触发的技能同理，放逐执行完就交回外层。遗言还没有。
 */
export async function runDay(input: DayInput): Promise<DayResult> {
  const { actions, minute, observe, onBallot, onFlow } = input;

  const election = await runSheriffElection(
    input.state,
    actions,
    minute,
    observe,
    onBallot,
    onFlow,
  );
  if (
    input.state.hasSheriff &&
    (input.state.day === 1 || input.state.sheriffElectionSuspended !== null)
  ) {
    await onFlow?.(election.state, {
      key: 'election-result',
      kind: 'sheriff',
      text: election.state.sheriffId
        ? `${seatNames(election.state, [election.state.sheriffId])} 当选警长。`
        : election.state.sheriffElectionSuspended
          ? '警长竞选被打断，下一天继续。'
          : '警长竞选结束，本局没有警长。',
    });
  }
  // 狼在警上爆了，这一天到此为止：没有发言也没有投票。
  if (election.aborted) {
    return { state: election.state, speeches: election.speeches, exiledId: null, ballots: [] };
  }

  const settled = await settleBadgeAfterDeaths(election.state, actions);
  // 竞选选出的警长、警徽的去向都落在这一段里，往后每个提问都要拿这份答；不在这儿交，
  // 直到发言前都还是入场那份，警长那一问的答案在局面里看不见。
  observe?.(settled);
  const blast = await runBlastWindow(settled, 'day', actions, observe, onFlow);
  if (blast.blasted) {
    return { state: blast.state, speeches: election.speeches, exiledId: null, ballots: [] };
  }

  const state = blast.state;
  const aliveSeatNos = state.players
    .filter((player) => player.isAlive)
    .map((player) => player.seatNo);
  // 今天出局的都算：夜里被刀的、刚被技能带走的都在这个口径里。
  const deadTodaySeatNos = state.players
    .filter((player) => !player.isAlive && player.deathDay === state.day)
    .map((player) => player.seatNo);
  const speechOrder = await daySpeechOrderOf(
    state,
    actions,
    aliveSeatNos,
    deadTodaySeatNos,
    minute,
  );

  await onFlow?.(state, {
    key: 'day-speech',
    text: `开始白天发言，顺序：${speechOrder.map((seat) => `${seat} 号`).join('、')}。`,
  });
  const speeches = await speakInOrder('day', speechOrder, state.players, actions);

  const exile = await runExile(state, actions, speechOrder, onBallot, onFlow);
  await onFlow?.(exile.state, {
    key: 'exile-result',
    text: exile.exiledId
      ? `${seatNames(state, [exile.exiledId])} 被放逐出局。`
      : '本轮无人被放逐。',
  });

  return {
    state: exile.state,
    speeches: [...election.speeches, ...speeches, ...exile.speeches],
    exiledId: exile.exiledId,
    ballots: exile.ballots,
  };
}

/** 白天的发言顺序：有警长听警长的，没警长按单顺双逆。 */
async function daySpeechOrderOf(
  state: GameState,
  actions: ActionProvider,
  aliveSeatNos: readonly number[],
  deadSeatNos: readonly number[],
  minute: number,
): Promise<number[]> {
  const { sheriffId } = state;
  if (sheriffId === null) return daySpeechOrder(aliveSeatNos, deadSeatNos, minute);

  const sheriff = state.players.find((player) => player.id === sheriffId);
  if (!sheriff) throw new Error(`警长不在局内：${sheriffId}`);

  return sheriffSpeechOrder(
    aliveSeatNos,
    sheriff.seatNo,
    await actions.chooseSpeechSide(sheriffId, state.day),
  );
}
