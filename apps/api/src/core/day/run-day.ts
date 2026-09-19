import type { ActionProvider } from '../actions';
import { daySpeechOrder, sheriffSpeechOrder } from '../speech-order';
import type { GameState } from '../state';
import { announceDay, type DeathAnnouncement, type NightDeath } from './announce';
import { settleBadgeAfterDeaths } from './badge';
import { runSheriffElection } from './election';
import { runExile } from './exile';
import { speakInOrder, type Speech } from './speech';

export interface DayInput {
  /** 天亮时的状态，夜间结算已经完成。 */
  state: GameState;
  actions: ActionProvider;
  /** 今晨公布的死者；空数组就是平安夜。 */
  nightDeaths: readonly NightDeath[];
  /** 当前时间的分钟数，用来算发言顺序。 */
  minute: number;
}

/** 一个白天走完之后的全部结果。 */
export interface DayResult {
  state: GameState;
  /** 公布出去的死讯，按座位号升序；空数组就是平安夜。 */
  announcements: DeathAnnouncement[];
  /** 按实际发生顺序排列的全部发言，含警上、白天常规与平票 PK 三轮。 */
  speeches: Speech[];
  /** 被放逐的玩家；无人出局为 null。 */
  exiledId: string | null;
}

/**
 * 走完一个白天：警长竞选 → 公布死讯 → 发言 → 投票 → 平票 PK → 放逐。
 *
 * 竞选排在公布死讯之前——今晨的死者死讯还没公布，仍算在局内，要上警、要发言、要投票。
 * 死讯落下之后警长若正好是今晨的死者，警徽要立刻处理，否则当天余下的环节会全都指着
 * 一个已经出局的人。
 *
 * 遗言与放逐触发的技能不在这一段，放逐执行完就交还给外层。
 */
export async function runDay(input: DayInput): Promise<DayResult> {
  const { actions, minute } = input;

  const election = await runSheriffElection(input.state, actions, minute);
  const announced = announceDay(election.state, input.nightDeaths);
  const state = await settleBadgeAfterDeaths(announced.state, actions);

  const aliveSeatNos = state.players
    .filter((player) => player.isAlive)
    .map((player) => player.seatNo);
  const speechOrder = await daySpeechOrderOf(
    state,
    actions,
    aliveSeatNos,
    announced.deaths.map((death) => death.seatNo),
    minute,
  );
  const speeches = await speakInOrder('day', speechOrder, state.players, actions);

  const exile = await runExile(state, actions, speechOrder);

  return {
    state: exile.state,
    announcements: announced.deaths,
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
