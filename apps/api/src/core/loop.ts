import { DEATH_CAUSES, type Faction } from '@werewolf/shared';
import type { ActionProvider } from './actions';
import { announceDay, type NightDeath } from './day/announce';
import { settleBadgeAfterDeaths } from './day/badge';
import type { ExileBallot } from './day/exile';
import { runDay } from './day/run-day';
import { triggerDeathSkills } from './deaths';
import { nextPhaseInstanceId, nodeNameOf, type PhaseInstanceId } from './identity';
import { runNight } from './night/run-night';
import { stageRandom } from './random';
import type { GameState } from './state';
import { checkWin } from './win';

/** 一天的四格，按这个顺序走。节点名同时是锚点认这一格的凭据，见 nodeNameOf。 */
const STAGES = ['night', 'deathSkills', 'day', 'exileSkills'] as const;
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
  /**
   * 交出 Core 收齐后才定得下来、外面看不到的事实。眼下只有票型：一轮投票并发问出去，
   * 各人的落点要等 Core 计完票才知道结果，这里是一次放逐投完之后唯一的出口。
   */
  onFacts?: (ballots: readonly ExileBallot[]) => Promise<void>;
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
 * 每个能死人的节点后都要判一次，判定顺序就是出局顺序：
 * 夜里死的和天亮公布完死讯判一次；出局技能连锁传完判一次；放逐执行完、它的技能还没触发
 * 之前判一次——已经分出胜负就不再开枪。判定之外，夜晚和白天各自只是顺序执行。
 *
 * 每进一格先落一份锚点：恢复从最后一份接着跑，前面那几格不重放。落了锚点才提问，
 * 于是断在哪一格，重进的就是哪一格——把它前面那几格再跑一遍不叫恢复。
 */
export async function runGame(input: GameLoopInput): Promise<GameLoopResult> {
  const { actions, minuteOf, observe, onStage, onFacts, maxDays = DEFAULT_MAX_DAYS } = input;
  const resume = input.resume ?? null;
  let state = resume?.state ?? input.state;
  // 这一轮从第几格起跑：恢复落在哪一格就从哪一格起，之后每轮都整轮走。
  let from = resume === null ? 0 : STAGES.indexOf(nodeNameOf(resume.phaseInstanceId) as StageName);
  if (from < 0) throw new Error(`锚点不在这一天的四格上：${resume?.phaseInstanceId}`);
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
    /** 这一轮被放逐的人，同上。 */
    let executed: readonly NightDeath[] = [];

    if (from <= 0) {
      const entered = await enter('night', state, {});
      const night = await runNight({ state: entered, actions, random: stageRandom(entered) });

      const dawn = announceDay(night.state, night.deaths);
      const winner = checkWin(dawn.state);
      if (winner !== null) return { state: dawn.state, winner };

      state = dawn.state;
      deaths = night.deaths;
    }

    if (from <= 1) {
      const dead = from > 0 ? anchoredDeaths(resume, 'deathSkills') : deaths;
      const woken = await triggerDeathSkills(
        await enter('deathSkills', state, { deaths: dead }),
        dead,
        actions,
        observe,
      );
      const winner = checkWin(woken);
      if (winner !== null) return { state: woken, winner };

      state = woken;
    }

    if (from <= 2) {
      // 分钟数现算；恢复落在这一格时取锚点里那份——时钟在核心外面，重问一次可能问出别的数。
      const minute = from > 1 ? anchoredMinute(resume) : minuteOf(state.day);
      const day = await runDay({
        state: await enter('day', state, { minute }),
        actions,
        minute,
        observe,
      });
      // 计完票才有的东西，交出去再判胜负：这一步不提问，早交晚交都不影响谁赢。
      if (day.ballots.length > 0) await onFacts?.(day.ballots);

      const winner = checkWin(day.state);
      if (winner !== null) return { state: day.state, winner };

      state = day.state;
      executed =
        day.exiledId === null ? [] : [{ playerId: day.exiledId, cause: DEATH_CAUSES.EXECUTION }];
    }

    // 四格到此为止，这一格跑不跑只由有没有死者定。
    const exileDeaths = from > 2 ? anchoredDeaths(resume, 'exileSkills') : executed;
    // 没人被放逐就不进这一格：原样多推一个实例，后面每一问的键都跟着挪一位。
    if (exileDeaths.length > 0) {
      const woken = await triggerDeathSkills(
        await enter('exileSkills', state, { deaths: exileDeaths }),
        exileDeaths,
        actions,
        observe,
      );
      const winner = checkWin(woken);
      if (winner !== null) return { state: woken, winner };

      // 连锁带走的人里可能有警长（狼王、猎人开枪打的就是他），当场结掉。
      // 拖到第二天早晨，候选名单已经被夜里的刀口改过一遍。
      state = await settleBadgeAfterDeaths(woken, actions);
      const badgeWinner = checkWin(state);
      if (badgeWinner !== null) return { state, winner: badgeWinner };
    }

    from = 0;
    // 这一轮没进过那一格（放逐技能那一格可以整段跳过）：恢复标记跟着作废，下一轮整轮走。
    resuming = false;
    const nextDay = state.day + 1;
    if (nextDay > maxDays) throw new Error(`第 ${maxDays} 天还没分出胜负`);
    state = { ...state, day: nextDay };
  }
}

/** 锚点那一格存下的死者。恢复接在别的格上就是调用方接错了，当场抛。 */
function anchoredDeaths(anchor: StageAnchor | null, name: StageName): readonly NightDeath[] {
  if (anchor === null || nodeNameOf(anchor.phaseInstanceId) !== name) {
    throw new Error(`锚点不在 ${name} 这一格上，取不到它的死者`);
  }

  // 存进去的就是这一格的输入，形状由节点名定，读回来认领成它而已。
  return (anchor.input as { deaths: readonly NightDeath[] }).deaths;
}

/** 锚点那一格存下的分钟数，同上。 */
function anchoredMinute(anchor: StageAnchor | null): number {
  if (anchor === null || nodeNameOf(anchor.phaseInstanceId) !== 'day') {
    throw new Error('锚点不在白天这一格上，取不到它的分钟数');
  }

  return (anchor.input as { minute: number }).minute;
}
