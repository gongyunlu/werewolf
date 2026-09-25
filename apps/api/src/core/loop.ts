import { DEATH_CAUSES, type Faction } from '@werewolf/shared';
import type { ActionProvider } from './actions';
import type { FlowObserver } from './flow';
import type { NightDeath } from './day/announce';
import { runDawn } from './day/dawn';
import { settleBadgeAfterDeaths } from './day/badge';
import type { BallotObserver } from './vote';
import { runDay } from './day/run-day';
import { triggerDeathSkills } from './deaths';
import { nextPhaseInstanceId, nodeNameOf, type PhaseInstanceId } from './identity';
import { runNight } from './night/run-night';
import { stageRandom } from './random';
import type { GameState } from './state';
import { checkWin } from './win';

/** 天亮阶段保存尚未公布的夜间结果，供竞选和恢复使用。 */
const STAGES = ['night', 'dawn', 'deathSkills', 'day', 'exileSkills', 'dayEnd'] as const;
type StageName = (typeof STAGES)[number];

/**
 * 阶段锚点：进一格时把完整局面和这一格的输入一起落下来。
 * 恢复把它取回来，直接拿这份局面跑这一格——序号不再推进，于是提问的键与断的那一次重合，
 * 答过的那些按记录复用，一个模型都不用问。
 */
export interface StageAnchor {
  phaseInstanceId: PhaseInstanceId;
  state: GameState;
  /** 这一格跑起来要的输入。形状随节点名定，只有下面两个读法取用。 */
  input: unknown;
}

export interface GameLoopInput {
  /** 出发时的局面；恢复时以 resume 里那份为准。 */
  state: GameState;
  actions: ActionProvider;
  /** 第 day 天发言方向的分钟数。时钟在核心外面，这里只收结果。 */
  minuteOf: (day: number) => number;
  /**
   * 交出现当局面的口子。核心自己不往外传状态，要拿全量局面只能从这个回调收。
   * 交出的时机是「局面刚变过、后面还有问题要问」：旧的那份已经不对了，新的这份还没人要过。
   */
  observe?: (state: GameState) => void;
  /** 落锚点的口子。不给就不留断点，这一跑断了只能从头再来。 */
  onStage?: (anchor: StageAnchor) => Promise<void>;
  /** 每轮计票后立即发布票型，后续发言与投票才能看到。 */
  onBallot?: BallotObserver;
  onFlow?: FlowObserver;
  /** 当日结算和胜负检查通过后、下一夜之前整理个人判断，不改变局面。 */
  onDayEnd?: () => Promise<void>;
  /** 从哪一格接着跑。局面与这一格的输入都以它为准，它前面那几格一概不重放。 */
  resume?: StageAnchor;
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
 * 每个能死人的节点后都要判一次，判定顺序就是出局顺序：夜里死的和天亮公布完死讯判一次；
 * 出局技能连锁里每带出一个人判一次、它自己就会收口；放逐执行完、它的技能还没触发之前判
 * 一次——已经分出胜负就不再开枪。判定之外，夜晚和白天各自只是顺序执行。
 *
 * 每进一格先落一份锚点：恢复从最后一份接着跑，前面那几格不重放。落了锚点才提问，
 * 于是断在哪一格，重进的就是哪一格——把它前面那几格再跑一遍不叫恢复。
 */
export async function runGame(input: GameLoopInput): Promise<GameLoopResult> {
  const {
    actions,
    minuteOf,
    observe,
    onStage,
    onBallot,
    onFlow,
    onDayEnd,
    maxDays = DEFAULT_MAX_DAYS,
  } = input;
  const resume = input.resume ?? null;
  let state = resume?.state ?? input.state;
  // 这一轮从第几格起跑：恢复落在哪一格就从哪一格起，之后每轮都整轮走。
  let from = resume === null ? 0 : STAGES.indexOf(nodeNameOf(resume.phaseInstanceId) as StageName);
  if (from < 0) throw new Error(`锚点不在这一天的流程中：${resume?.phaseInstanceId}`);
  // 认格按行里那份，做键按局面里那份，两份对不上就不是这一格的进度，接下去全错位。
  if (resume !== null && resume.state.phaseInstanceId !== resume.phaseInstanceId) {
    throw new Error(`锚点里那份局面不在这一格上：${resume.phaseInstanceId}`);
  }

  // 头一次进的那一格就是接着跑的那一格：序号已经在锚点里了，不能再推一次。
  let resuming = resume !== null;

  /** 进一格：推进实例序号、落下锚点，再把这格的局面交出去。 */
  async function enter(
    name: StageName,
    before: GameState,
    stageInput: unknown,
  ): Promise<GameState> {
    const skipAdvance = resuming;
    resuming = false;

    // 推了序号，提问的键就全换一个，答过的那些对不上记录，一个都复用不了。
    const next = skipAdvance
      ? before
      : { ...before, phaseInstanceId: nextPhaseInstanceId(before.phaseInstanceId, name) };
    await onStage?.({ phaseInstanceId: next.phaseInstanceId, state: next, input: stageInput });

    observe?.(next);
    return next;
  }

  while (true) {
    /** 这一轮的死者：跑过夜就是夜里结算出来的，恢复落在天亮那一格时取自锚点。 */
    let deaths: readonly NightDeath[] = [];
    let aborted = false;
    /** 这一轮被放逐的人，同上。 */
    let executed: readonly NightDeath[] = [];

    if (from <= 0) {
      const entered = await enter('night', state, {});
      const night = await runNight({
        state: entered,
        actions,
        random: stageRandom(entered),
        onFlow,
      });

      state = night.state;
      deaths = night.deaths;
    }

    if (from <= 1) {
      const dawnInput =
        from === 1
          ? anchoredInput<{ deaths: readonly NightDeath[]; minute: number }>(resume, 'dawn')
          : { deaths, minute: minuteOf(state.day) };
      const dawn = await runDawn({
        state: await enter('dawn', state, dawnInput),
        ...dawnInput,
        actions,
        observe,
        onBallot,
        onFlow,
      });
      const winner = checkWin(dawn.state);
      if (winner !== null) return { state: dawn.state, winner };
      state = dawn.state;
      deaths = dawn.deaths;
      aborted = dawn.aborted;
    }

    if (from <= 2) {
      const skillInput =
        from === 2
          ? anchoredInput<{ deaths: readonly NightDeath[]; aborted?: boolean }>(
              resume,
              'deathSkills',
            )
          : { deaths, aborted };
      const woken = await triggerDeathSkills(
        await enter('deathSkills', state, skillInput),
        skillInput.deaths,
        actions,
        observe,
        onFlow,
      );
      const winner = checkWin(woken);
      if (winner !== null) return { state: woken, winner };

      state = await settleBadgeAfterDeaths(woken, actions);
      observe?.(state);
      aborted = skillInput.aborted === true;
    }

    if (from <= 3 && !aborted) {
      // 分钟数现算；恢复落在这一格时取锚点里那份——时钟在核心外面，重问一次可能问出别的数。
      const minute =
        from === 3 ? anchoredInput<{ minute: number }>(resume, 'day').minute : minuteOf(state.day);
      const day = await runDay({
        state: await enter('day', state, { minute }),
        actions,
        minute,
        observe,
        onBallot,
        onFlow,
      });

      const winner = checkWin(day.state);
      if (winner !== null) return { state: day.state, winner };

      state = day.state;
      executed =
        day.exiledId === null ? [] : [{ playerId: day.exiledId, cause: DEATH_CAUSES.EXECUTION }];
    }

    const exileDeaths =
      from === 4
        ? anchoredInput<{ deaths: readonly NightDeath[] }>(resume, 'exileSkills').deaths
        : executed;
    // 没人被放逐就不进这一格：原样多推一个实例，后面每一问的键都跟着挪一位。
    if (exileDeaths.length > 0) {
      const woken = await triggerDeathSkills(
        await enter('exileSkills', state, { deaths: exileDeaths }),
        exileDeaths,
        actions,
        observe,
        onFlow,
      );
      const winner = checkWin(woken);
      if (winner !== null) return { state: woken, winner };

      // 连锁带走的人里可能有警长（狼王、猎人开枪打的就是他），当场结掉。
      // 拖到第二天早晨，候选名单已经被夜里的刀口改过一遍。
      state = await settleBadgeAfterDeaths(woken, actions);
      const badgeWinner = checkWin(state);
      if (badgeWinner !== null) return { state, winner: badgeWinner };
    }

    const nextDay = state.day + 1;
    if (nextDay > maxDays) throw new Error(`第 ${maxDays} 天还没分出胜负`);
    if (onDayEnd) {
      state = await enter('dayEnd', state, from === 5 ? resume!.input : {});
      await onDayEnd();
    }

    from = 0;
    // 这一轮没进过那一格（放逐技能那一格可以整段跳过）：恢复标记跟着作废，下一轮整轮走。
    resuming = false;
    state = { ...state, day: nextDay };
  }
}

/** 按节点取回锚点输入，不能拿别的阶段的数据恢复。 */
function anchoredInput<T>(anchor: StageAnchor | null, name: StageName): T {
  if (anchor === null || nodeNameOf(anchor.phaseInstanceId) !== name) {
    throw new Error(`锚点不在 ${name} 这一格上，取不到它的输入`);
  }

  // 存进去的就是这一格的输入，形状由节点名定，读回来认领成它而已。
  return anchor.input as T;
}
