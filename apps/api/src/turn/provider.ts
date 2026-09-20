import { ACTION_TYPES } from '@werewolf/shared';
import type { ActionProvider, BallotTurn, SpeechTurn, WitchDecision } from '../core/actions';
import type { GameState } from '../core/state';
import { playerOf, seatIndexOf, turnContextOf } from './context';
import { decisionShape, type DecisionShapeName, type DecisionShapes } from './decisions';
import { runActionGraph, type TurnOutcome } from './graph';
import { ledger } from './ledger';
import { presetOf } from './presets';
import { actionOrdinals, type ActionRequest, type TurnRuntime } from './request';

/**
 * 把玩家决定交给模型的行动提供者。
 *
 * 它做三件事：把端口那点参数渲染成一次提问、把模型的答案换回 Core 要的值、把过程记进台账。
 * 它不判规则——候选是否合法是 Core 的、答案形状对不对是行动图 schema 的，这里两条都不重做。
 *
 * 全量局面由 Core 从 observe() 交进来（见 GameLoopInput.observe），端口签名里一个状态字段都没有。
 */
export interface ModelActions extends ActionProvider {
  /** 接给 runGame 的 observe：Core 每改完一次局面就会调它。 */
  observe(state: GameState): void;
  /**
   * 这局做过的全部决定，按跑完的先后。
   * 同一批并发提问（投票、提刀、自爆）里谁先跑完由模型延迟决定，那个先后不代表牌桌上的先后。
   */
  outcomes(): readonly TurnOutcome[];
}

/** 一次提问里除了形状都齐了的那几项。 */
interface AskInput<K extends DecisionShapeName> {
  actionType: ActionRequest['actionType'];
  actorId: string;
  /** 这次要他做什么，一句人话。 */
  task: string;
  shape: K;
  /** 这次能选的玩家 id；做/不做两态的行动不传。 */
  candidates?: readonly string[];
  /** 解药那一支摆不摆得出来，只有女巫那一问会传。 */
  antidoteAllowed?: boolean;
  /** 补进局面、这个端口方法才有的那几行。 */
  extra?: readonly string[];
}

/** 各轮发言要做什么。键与动作类型的取值域同一份，少一个编译期就报。 */
const SPEECH_TASKS: Readonly<Record<SpeechTurn, string>> = {
  campaign: '轮到你上警发言。',
  campaign_pk: '警上平票，轮到你做一轮 PK 发言。',
  day: '轮到你发言。',
  exile_pk: '放逐平票，轮到你做一轮 PK 发言。',
};

/** 各轮投票要选什么。 */
const BALLOT_TASKS: Readonly<Record<BallotTurn, string>> = {
  campaign: '投出你要选的警长。',
  campaign_pk: '警长竞选平票，在平票的这几个人里投一位。',
  exile: '投出你今天要放逐的人。',
  exile_pk: '放逐平票，在平票的这几个人里投一位。',
};

/** 发言正文收成一行：台账是按条渲染的，话里的换行会把条目截断。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function modelActions(runtime: TurnRuntime): ModelActions {
  let current: GameState | null = null;
  const process = ledger();
  const ordinal = actionOrdinals();
  const taken: TurnOutcome[] = [];

  function stateNow(): GameState {
    if (current === null) throw new Error('还没收到当前局面：Core 得先交一次');
    return current;
  }

  function seatNoOf(playerId: string): number {
    return playerOf(stateNow(), playerId).seatNo;
  }

  /** 记一条公开过程。答完题就记，答之前要用的只有局面和台账。 */
  function record(text: string): void {
    process.add(stateNow().day, text);
  }

  /**
   * 问一次模型。
   * 候选的座位号从 Core 递进来的 id 现算，schema 与提示词里的候选渲染共用这一份座位号，
   * 模型答的座位号再沿着同一张对照表换回 id。
   */
  async function ask<K extends DecisionShapeName>(input: AskInput<K>): Promise<DecisionShapes[K]> {
    const state = stateNow();
    const index = seatIndexOf(state);
    const candidates = input.candidates ?? [];
    const shape = decisionShape(input.shape, {
      seatNos: candidates.map((playerId) => index.toSeatNo(playerId)),
      antidoteAllowed: input.antidoteAllowed,
    });
    const scope = { gameId: state.gameId, phaseInstanceId: state.phaseInstanceId };
    const request: ActionRequest = {
      scope,
      actionType: input.actionType,
      actorId: input.actorId,
      actionOrdinal: ordinal(scope, input.actionType, input.actorId),
      preset: presetOf(input.actionType),
      context: turnContextOf({
        state,
        ledger: process,
        playerId: input.actorId,
        task: input.task,
        candidates,
        extra: input.extra,
      }),
      schema: shape.schema,
    };

    const outcome = await runActionGraph(runtime, request);
    taken.push(outcome);

    // 形状已经由 schema 卡过，认领只是把 unknown 收回形状名对应的那个类型。
    const toPlayerId = (seatNo: number): string => index.toPlayerId(seatNo);
    return shape.toCore(outcome.decision, toPlayerId) as DecisionShapes[K];
  }

  return {
    observe(state) {
      current = state;
    },
    outcomes: () => taken,

    async runForSheriff(playerId) {
      const run = await ask({
        actionType: ACTION_TYPES.SHERIFF_CANDIDACY,
        actorId: playerId,
        task: '决定是否上警竞选警长。',
        shape: 'yesOrNo',
      });
      if (run) record(`${seatNoOf(playerId)} 号上警。`);
      return run;
    },

    async withdraw(playerId) {
      const gone = await ask({
        actionType: ACTION_TYPES.SHERIFF_WITHDRAW,
        actorId: playerId,
        task: '要不要退水退出竞选。退水之后既不能被选，也没有票。',
        shape: 'yesOrNo',
      });
      if (gone) record(`${seatNoOf(playerId)} 号退水。`);
      return gone;
    },

    async speak(round, playerId) {
      const content = await ask({
        actionType: ACTION_TYPES.SPEECH,
        actorId: playerId,
        task: SPEECH_TASKS[round],
        shape: 'speech',
      });
      record(`${seatNoOf(playerId)} 号发言：${oneLine(content)}`);
      return content;
    },

    // 票型不进台账：一轮投票是并发问的，答完只是各自的落点，谁赢由 Core 收齐后计票。
    // 记下去就得记在别人答完之后，同轮的人会看到别人的票，规则里没有这回事。
    async vote(round, playerId, candidates) {
      return ask({
        actionType: ACTION_TYPES.VOTE,
        actorId: playerId,
        task: BALLOT_TASKS[round],
        shape: 'seatOrNone',
        candidates,
        extra: ['投空就是弃票。'],
      });
    },

    async chooseSpeechSide(sheriffId) {
      const side = await ask({
        actionType: ACTION_TYPES.SHERIFF_DECIDE_ORDER,
        actorId: sheriffId,
        task: '决定今天从你的哪一边开始发言。left 是逆时针，right 是顺时针。',
        shape: 'speechSide',
      });
      record(`警长 ${seatNoOf(sheriffId)} 号决定从${side === 'left' ? '左' : '右'}边开始。`);
      return side;
    },

    async decideBadge(sheriffId, candidates) {
      const decision = await ask({
        actionType: ACTION_TYPES.SHERIFF_TRANSFER,
        actorId: sheriffId,
        task: '你出局了，决定警徽交给谁，还是撕掉。',
        shape: 'badgeDecision',
        candidates,
      });
      const mine = seatNoOf(sheriffId);
      record(
        decision.kind === 'transfer'
          ? `${mine} 号把警徽交给了 ${seatNoOf(decision.toId)} 号。`
          : `${mine} 号撕掉了警徽。`,
      );
      return decision;
    },

    async wolfProposal(wolfId, candidates) {
      return ask({
        actionType: ACTION_TYPES.WOLF_PROPOSAL,
        actorId: wolfId,
        task: '决定今晚狼队刀谁。不刀也是合法的一票，队里取众数。',
        shape: 'seatOrNone',
        candidates,
        extra: ['狼队各提各的，队里取众数，你看不到别的狼提了谁。'],
      });
    },

    async guardProtect(guardId, candidates) {
      return ask({
        actionType: ACTION_TYPES.GUARD_PROTECT,
        actorId: guardId,
        task: '决定今晚守护谁。守护挡住狼刀，挡不住女巫的毒。',
        shape: 'seatOrNone',
        candidates,
      });
    },

    async seerCheck(seerId, candidates) {
      return ask({
        actionType: ACTION_TYPES.SEER_CHECK,
        actorId: seerId,
        task: '决定今晚查验谁。你今晚看到的结果，明天只能靠你自己说出去。',
        shape: 'seat',
        candidates,
      });
    },

    async witchDecision(witchId, killTargetId, poisonCandidates): Promise<WitchDecision> {
      const state = stateNow();
      // 能不能自救按 Core 的同一条规则现算，摆不出来的那一支干脆不摆：
      // 摆出去让她选、选了再等 Core 抛错，等于把规则判到了错误处理里。
      const selfTarget = killTargetId === witchId;
      const canSave = killTargetId !== null && !selfTarget;

      return ask({
        actionType: ACTION_TYPES.WITCH_DECISION,
        actorId: witchId,
        task: '决定今晚救、毒还是都不用。两瓶药不能同一夜都用。',
        shape: 'witchDecision',
        candidates: poisonCandidates,
        antidoteAllowed: canSave,
        extra: [
          killTargetId === null
            ? '你今晚看不到刀口。'
            : selfTarget
              ? '今晚的刀口是你自己，解药救不了自己。'
              : `今晚的刀口是 ${playerOf(state, killTargetId).seatNo} 号。`,
          canSave
            ? '解药只能用在今晚的刀口上，毒药可以毒场上任何一个还活着的人。'
            : '毒药可以毒场上任何一个还活着的人。',
        ],
      });
    },

    async hunterShot(hunterId, candidates) {
      return ask({
        actionType: ACTION_TYPES.HUNTER_SHOT,
        actorId: hunterId,
        task: '你出局了，决定是否开枪带走一个人。',
        shape: 'seatOrNone',
        candidates,
      });
    },

    async wolfKingShot(wolfKingId, candidates) {
      return ask({
        actionType: ACTION_TYPES.WOLF_KING_SHOT,
        actorId: wolfKingId,
        task: '你出局了，决定是否带一个人走。',
        shape: 'seatOrNone',
        candidates,
      });
    },

    // 自爆也不进台账，理由同投票：一轮窗口并发问完所有狼，答「爆」的不止一只，真爆的只有座位最靠前那只。
    // 谁真出局了看局面里的出局名单，那份是权威的。
    async wolfBlast(wolfId, resuming) {
      return ask({
        actionType: ACTION_TYPES.WOLF_EXPLODE,
        actorId: wolfId,
        task: resuming
          ? '竞选续轮里可以自爆。自爆会出局并废掉今天的竞选。'
          : '现在是自爆窗口。自爆会出局，这一天剩下的环节全部跳过。',
        shape: 'yesOrNo',
      });
    },

    async whiteWolfTake(whiteWolfId, candidates) {
      return ask({
        actionType: ACTION_TYPES.WHITE_WOLF_TAKE,
        actorId: whiteWolfId,
        task: '你自爆出局了，决定是否带一个人一起走。',
        shape: 'seatOrNone',
        candidates,
      });
    },
  };
}
