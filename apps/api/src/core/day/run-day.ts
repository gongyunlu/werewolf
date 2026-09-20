import type { ActionProvider } from '../actions';
import { daySpeechOrder, sheriffSpeechOrder } from '../speech-order';
import type { GameState } from '../state';
import { settleBadgeAfterDeaths } from './badge';
import { runSheriffElection } from './election';
import { runExile } from './exile';
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
}

/** 一个白天走完之后的全部结果。 */
export interface DayResult {
  state: GameState;
  /** 按实际发生顺序排的全部发言，含警上、白天常规与 PK 三轮。 */
  speeches: Speech[];
  /** 被放逐的玩家；无人出局、当天被自爆打断，都是 null。 */
  exiledId: string | null;
}

/**
 * 走完一个白天：警长竞选 → 警徽处理 → 自爆窗口 → 发言 → 投票 → 平票 PK → 放逐。
 *
 * 死讯公布和出局技能的结算不在这里：它们每走一步都可能分出胜负，得让外层在中间停下来判。
 * 放逐触发的技能同理，放逐执行完就交回外层。遗言还没有。
 */
export async function runDay(input: DayInput): Promise<DayResult> {
  const { actions, minute, observe } = input;

  const election = await runSheriffElection(input.state, actions, minute);
  // 狼在警上爆了，这一天到此为止：没有发言也没有投票。
  if (election.aborted) {
    return { state: election.state, speeches: election.speeches, exiledId: null };
  }

  const settled = await settleBadgeAfterDeaths(election.state, actions);
  // 竞选选出的警长、警徽的去向都落在这一段里，往后每个提问都要拿这份答；不在这儿交，
  // 直到发言前都还是入场那份，警长那一问的答案在局面里看不见。
  observe?.(settled);
  const blast = await runBlastWindow(settled, 'day', actions, observe);
  if (blast.blasted) {
    return { state: blast.state, speeches: election.speeches, exiledId: null };
  }

  let state = blast.state;
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

  // 每段发言之后再开一次自爆窗口：听完某个人再爆，是「非投票阶段任意时刻」的落点。
  // 有人爆了就停，后面的人没发言，投票和放逐当天也不再走。
  let blasted = false;
  const speeches = await speakInOrder('day', speechOrder, state.players, actions, async () => {
    const midBlast = await runBlastWindow(state, 'day', actions, observe);
    state = midBlast.state;
    blasted = midBlast.blasted;
    return blasted;
  });
  if (blasted) return { state, speeches: [...election.speeches, ...speeches], exiledId: null };

  const exile = await runExile(state, actions, speechOrder);

  return {
    state: exile.state,
    speeches: [...election.speeches, ...speeches, ...exile.speeches],
    exiledId: exile.exiledId,
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
