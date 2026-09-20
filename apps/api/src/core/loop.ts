import { DEATH_CAUSES, type Faction } from '@werewolf/shared';
import type { RandomSource } from '../boards/deal';
import type { ActionProvider } from './actions';
import { announceDay } from './day/announce';
import { settleBadgeAfterDeaths } from './day/badge';
import { runDay, type DayResult } from './day/run-day';
import { triggerDeathSkills } from './deaths';
import { nextPhaseInstanceId } from './identity';
import { runNight } from './night/run-night';
import type { GameState } from './state';
import { checkWin } from './win';

export interface GameLoopInput {
  /** 建局时的状态。 */
  state: GameState;
  actions: ActionProvider;
  /** 狼队提刀并列时的随机源。 */
  random: RandomSource;
  /** 第 day 天发言方向的分钟数。时钟在核心外面，这里只收结果。 */
  minuteOf: (day: number) => number;
  /**
   * 交出现当局面的口子。核心自己不往外传状态，要拿全量局面只能从这个回调收。
   * 交出的时机是「局面刚变过、后面还有问题要问」：旧的那份已经不对了，新的这份还没人要过。
   */
  observe?: (state: GameState) => void;
  /** 天数上限，默认 20；到点还没分出胜负就是引擎没停下来。 */
  maxDays?: number;
}

export interface GameLoopResult {
  state: GameState;
  /** 终局的胜方；能返回就一定有胜方，不打平。 */
  winner: Faction;
}

const DEFAULT_MAX_DAYS = 20;

/**
 * 从第一天入夜一路推到分出胜负。
 *
 * 每个能死人的节点后都要判一次，判定顺序就是出局顺序：
 * 夜里死的和天亮公布完死讯判一次；出局技能连锁传完判一次；放逐执行完、它的技能还没触发
 * 之前判一次——已经分出胜负就不再开枪。判定之外，夜晚和白天各自只是顺序执行。
 */
export async function runGame(input: GameLoopInput): Promise<GameLoopResult> {
  const { actions, random, minuteOf, observe, maxDays = DEFAULT_MAX_DAYS } = input;
  let state = input.state;

  while (true) {
    const night = await runNight({ state: atPhase(state, 'night', observe), actions, random });

    const dawn = announceDay(night.state, night.deaths);
    const dawnWinner = checkWin(dawn.state);
    if (dawnWinner !== null) return { state: dawn.state, winner: dawnWinner };

    const woken = await triggerDeathSkills(
      atPhase(dawn.state, 'deathSkills', observe),
      night.deaths,
      actions,
      observe,
    );
    const wokenWinner = checkWin(woken);
    if (wokenWinner !== null) return { state: woken, winner: wokenWinner };

    const day = await runDay({
      state: atPhase(woken, 'day', observe),
      actions,
      minute: minuteOf(woken.day),
      observe,
    });
    const dayWinner = checkWin(day.state);
    if (dayWinner !== null) return { state: day.state, winner: dayWinner };

    const after = await settleExile(day, actions, observe);
    const exileWinner = checkWin(after);
    if (exileWinner !== null) return { state: after, winner: exileWinner };

    const nextDay = after.day + 1;
    if (nextDay > maxDays) throw new Error(`第 ${maxDays} 天还没分出胜负`);
    state = { ...after, day: nextDay };
  }
}

/** 放逐出局后触发技能；没人被放逐就原样交回。 */
async function settleExile(
  day: DayResult,
  actions: ActionProvider,
  observe?: (state: GameState) => void,
): Promise<GameState> {
  if (day.exiledId === null) return day.state;

  const after = await triggerDeathSkills(
    atPhase(day.state, 'exileSkills', observe),
    [{ playerId: day.exiledId, cause: DEATH_CAUSES.EXECUTION }],
    actions,
    observe,
  );

  // 连锁带走的人里可能有警长（狼王、猎人开枪打的就是他），当场结掉。
  // 拖到第二天早晨，候选名单已经被夜里的刀口改过一遍。
  return settleBadgeAfterDeaths(after, actions);
}

/** 推进到下一个顶层节点实例。序号全局自增，与天数无关。 */
function atPhase(
  state: GameState,
  nodeName: string,
  observe?: (state: GameState) => void,
): GameState {
  const next = { ...state, phaseInstanceId: nextPhaseInstanceId(state.phaseInstanceId, nodeName) };
  observe?.(next);
  return next;
}
