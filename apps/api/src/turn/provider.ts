import { ACTION_TYPES, VISIBILITY_TYPES } from '@werewolf/shared';
import type { ActionProvider, BallotTurn, SpeechTurn, WitchDecision } from '../core/actions';
import type { Ballot } from '../core/vote';
import type { FlowObserver } from '../core/flow';
import { actionKey, nodeNameOf, type PhaseInstanceId } from '../core/identity';
import { audienceOf } from '../core/visibility';
import type { GameState } from '../core/state';
import { recordingModelPort } from '../llm/recording-model-port';
import type { ScenarioId } from '../skills/game-skills';
import type { StoredAction } from '../store/actions';
import { EVENT_KINDS, type EventKind } from '../store/events';
import type { GameStores } from '../store/stores';
import { playerOf, seatIndexOf, turnContextOf } from './context';
import { decisionShape, type DecisionShapeName, type DecisionShapes } from './decisions';
import { runActionGraph, type ActionControl, type TurnOutcome } from './graph';
import { chooseBlaster } from './blast';
import { ledger, type Ledger } from './ledger';
import { presetOf } from './presets';
import { actionOrdinals, type ActionRequest, type TurnRuntime } from './request';
import { summarize } from './summary';

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
  /** 本轮计票后记入台账。 */
  recordBallot(ballot: Ballot): Promise<void>;
  recordFlow: FlowObserver;
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
  /** 这一问属于哪个场景；不给就是没有场景正文可带。 */
  scenario?: ScenarioId;
  /** 狼队商议直接提交，公开发言仍按行动类型复核。 */
  preset?: ActionRequest['preset'];
  /** 这次能选的玩家 id；做/不做两态的行动不传。 */
  candidates?: readonly string[];
  /** 解药那一支摆不摆得出来，只有女巫那一问会传。 */
  antidoteAllowed?: boolean;
  /** 补进「这一问的说明」那块、这个端口方法才有的那几行。 */
  extra?: readonly string[];
  /** 答完之后往台账里记什么；这一次不留痕就返回 null。 */
  fact?: (value: DecisionShapes[K]) => FactRecord | null;
  actionOrdinal?: number;
  control?: ActionControl;
}

/** 一条要进台账的事实：属于哪一类、正文，以及它记下那一刻谁看得到。 */
interface FactRecord {
  kind: EventKind;
  text: string;
  audience: readonly string[];
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

/**
 * 折摘要是哪两个渠道：题面里怎么称呼它，以及折出来的那几行怎么开头。
 * 只列摘要那两类；拿别的类别来查是上游算错了，查不到当场抛。
 */
const SUMMARY_CHANNELS: Readonly<Partial<Record<EventKind, { title: string; prefix: string }>>> = {
  [EVENT_KINDS.PUBLIC_SUMMARY]: { title: '公开发言', prefix: '发言摘要' },
  [EVENT_KINDS.WOLF_SUMMARY]: { title: '狼队商议', prefix: '商议摘要' },
};

/** 发言正文收成一行：台账是按条渲染的，话里的换行会把条目截断。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 票型写成人话：谁投了谁、谁弃票，再接一句计票结果。 */
function ballotText(ballot: Ballot, seatNoOf: (playerId: string) => number): string {
  const casts = ballot.casts
    .map((cast) =>
      cast.targetId === null
        ? `${seatNoOf(cast.voterId)} 号弃票`
        : `${seatNoOf(cast.voterId)} 号投给 ${seatNoOf(cast.targetId)} 号`,
    )
    .join('、');

  const { outcome } = ballot;
  // 票数不报出来：警长那张票按 1.5 计，报出来会写成「2.5 票」，跟上面逐张列的票型对不上。
  const result =
    outcome.kind === 'elected'
      ? `${seatNoOf(outcome.winnerId)} 号票最多`
      : outcome.kind === 'tie'
        ? `${outcome.tiedIds.map((id) => `${seatNoOf(id)} 号`).join('、')}平票`
        : '全员弃票';

  const names: Record<BallotTurn, string> = {
    campaign: '警长竞选投票',
    campaign_pk: '警长竞选 PK 投票',
    exile: '放逐投票',
    exile_pk: '放逐 PK 投票',
  };
  return `${names[ballot.round]}：${casts}；${result}。`;
}

export function modelActions(
  runtime: TurnRuntime,
  stores: GameStores,
  resumePhase?: PhaseInstanceId,
): ModelActions {
  let current: GameState | null = null;
  let process: Promise<Ledger> | undefined;
  const ordinal = actionOrdinals();
  const taken: TurnOutcome[] = [];
  // 旧版本没有法官播报。恢复时只播接下来发生的流程，不把过去的提示追加到时间线末尾。
  let replaying: Promise<Set<string>> | undefined;
  function replayingKeys(): Promise<Set<string>> {
    return (replaying ??= resumePhase
      ? stores.actions
          .list(stateNow().gameId)
          .then(
            (rows) =>
              new Set(
                rows
                  .filter((row) => row.phaseInstanceId === resumePhase && row.status === 'done')
                  .map((row) => row.actionKey),
              ),
          )
      : Promise.resolve(new Set<string>()));
  }
  function stateNow(): GameState {
    if (current === null) throw new Error('还没收到当前局面：Core 得先交一次');
    return current;
  }

  function seatNoOf(playerId: string): number {
    return playerOf(stateNow(), playerId).seatNo;
  }

  /**
   * 摆好落提问那一层，交出去问这一问。
   *
   * 提问只有端口这一个出口，包在这儿，行动图那三问与折摘要那一问一处不漏；
   * 包在端口重试那一层外面（拼端口的地方见 llm/from-env）：那边重发的是同一份题面，
   * 包在里面只是重复落几遍。
   *
   * @param key 这一问属于哪次行动；折摘要那一问不在行动里，给 null
   * @returns 换了端口的运行环境，其余几项原样
   */
  function logged(key: string | null, summaryKey?: string): TurnRuntime {
    return {
      ...runtime,
      port: recordingModelPort(
        runtime.port,
        (asked) =>
          stores.asked.append(stateNow().gameId, {
            ...asked,
            actionKey: key,
            ...(summaryKey ? { summaryKey } : {}),
          }),
        { gameId: stateNow().gameId, actionKey: key, summaryKey },
      ),
    };
  }

  /**
   * 台账：一局一份，第一次用到时把库里那几段取回来铺上。
   * 接的是一整份 promise 而不是台账本身：同一轮里几个人是并发问出去的，
   * 各自等一次取库没关系，但只能铺出一份台账，不然他们记下的过程会散在两份里。
   */
  function ledgerNow(): Promise<Ledger> {
    if (!process) {
      const { gameId } = stateNow();
      process = stores.events.list(gameId).then((stored) => ledger(stores.events, gameId, stored));
    }
    return process;
  }

  /** 记一条过程。答完题就记，答之前要用的只有局面和台账。 */
  async function record(key: string, fact: FactRecord): Promise<void> {
    const facts = await ledgerNow();
    await facts.add(key, stateNow().day, fact.text, fact.audience, fact.kind);
  }

  /** 正在折的那一批；折完就清掉，好让后面新折进来的天再走一遍。 */
  let folding: Promise<void> | undefined;

  /**
   * 把窗口外那几天还没折的发言折成摘要，落进台账。
   *
   * 同一轮里并发问出去的几个人会同时走到这儿，共用同一份：各折各的话，
   * 台账那边认得出「这一条已经记过」，当场就把整局绊倒。
   * 等的是同一份，所以谁都不会在摘要还没落的时候就去取上下文。
   */
  function ensureSummaries(facts: Ledger): Promise<void> {
    folding ??= foldPending(facts).finally(() => {
      folding = undefined;
    });
    return folding;
  }

  async function foldPending(facts: Ledger): Promise<void> {
    for (const task of facts.pendingSummaries()) {
      const channel = SUMMARY_CHANNELS[task.kind];
      if (!channel) throw new Error(`不是摘要的类别：${task.kind}`);

      const items = await summarize(logged(null, task.key), {
        day: task.day,
        channel: channel.title,
        speeches: task.speeches.map((said) => ({
          seatNo: seatNoOf(said.actorId),
          lines: said.lines,
        })),
      });

      // 一天一条，正文里每人一行：明细那几行已经折掉了，读到的就是这几行。
      await facts.addSummary(
        task,
        items.map((item) => `${item.seatNo} 号${channel.prefix}：${oneLine(item.gist)}`).join('\n'),
      );
    }
  }

  /** 公开事实：此刻在场的所有人都看得到，死者也有旁观权。 */
  function publicFact(kind: EventKind, text: string): FactRecord {
    return { kind, text, audience: audienceOf(stateNow().players, VISIBILITY_TYPES.PUBLIC) };
  }

  /**
   * 这一问要带的技能正文，按「板子 → 角色 → 场景 → 这个人自己的人设与策略」排。
   *
   * 每问都带一份：系统提示词明说过没写出来的就是看不到的、别替规则补全，
   * 所以模型手里关于狼人杀的全部知识就是前几段，不带它就只能瞎猜；
   * 人设与策略排在最后，它管的是这个人怎么答，不掺进规则正文里。
   */
  function skillFor(state: GameState, playerId: string, scenario?: ScenarioId): string[] {
    const player = playerOf(state, playerId);

    return [
      runtime.skills.ruleset.content,
      runtime.skills.role(player.role).content,
      ...(scenario ? [runtime.skills.scenario(scenario).content] : []),
      ...runtime.memoriesFor(player.seatNo),
    ];
  }

  /** 狼队频道那份：只有此刻还活着、并且进了频道的狼看得到。 */
  function wolfFact(kind: EventKind, text: string): FactRecord {
    return { kind, text, audience: audienceOf(stateNow().players, VISIBILITY_TYPES.WOLF) };
  }

  /**
   * 跑这一次提问，或者用上一次已经答完的那一份。
   *
   * 同一个行动键上答过的那一次原样复用：断点续跑重走到这里时不再打扰模型，
   * 也保证一局之内同一个键拿到的是同一个答案——采样是随机的，再问一次问不出同一份。
   * 行动键在一局里唯一确定一次提问（跨局的对局 id 又不同），所以复用不会拿错别人的答案。
   *
   * 立了意图还没答完的照样往下跑：这一问得重新问一遍模型，库里那行只是「问过、没答完」的痕迹。
   *
   * @param request 这一次提问
   * @param key 它的行动键，调用方算过一次——题面要先按它去记录里取那一刻的台账
   * @param remembered 记录里那一行；第一次问就是 null
   * @param ledgerSeq 台账此刻记到第几条，第一次问时存下
   */
  async function once(
    request: ActionRequest,
    key: string,
    remembered: StoredAction | null,
    ledgerSeq: number,
    control?: ActionControl,
  ): Promise<TurnOutcome> {
    const generated = control?.generated;
    if (generated?.completion && generated.values.sourceCallId) {
      await stores.asked.finishCall(generated.values.sourceCallId, generated.completion);
    }
    if (remembered) {
      // 落进去的就是这次行动交出去的原物，认领回它的类型而已。
      if (remembered.status === 'done') {
        (await replayingKeys()).delete(key);
        return remembered.outcome as TurnOutcome;
      }
    } else {
      await stores.actions.begin({
        actionKey: key,
        gameId: request.scope.gameId,
        phaseInstanceId: request.scope.phaseInstanceId,
        actionType: request.actionType,
        actorId: request.actorId,
        actionOrdinal: request.actionOrdinal,
        ledgerSeq,
      });
    }

    const outcome = await runActionGraph(logged(key), request, {
      saver: stores.checkpoints,
      resume: remembered?.status === 'running',
      control,
    });
    await stores.actions.finish(key, outcome);
    return outcome;
  }

  /**
   * 问一次模型。
   * 候选的座位号从 Core 递进来的 id 现算，schema 与提示词里的候选渲染共用这一份座位号，
   * 模型答的座位号再沿着同一张对照表换回 id。
   */
  async function ask<K extends DecisionShapeName>(input: AskInput<K>): Promise<DecisionShapes[K]> {
    await replayingKeys();
    const state = stateNow();
    const facts = await ledgerNow();
    // 折摘要要在拼题面之前：下面取的就是台账，晚一步取的还是没折的那一份。
    await ensureSummaries(facts);
    const index = seatIndexOf(state);
    const candidates = input.candidates ?? [];
    const shape = decisionShape(input.shape, {
      seatNos: candidates.map((playerId) => index.toSeatNo(playerId)),
      antidoteAllowed: input.antidoteAllowed,
    });
    const scope = { gameId: state.gameId, phaseInstanceId: state.phaseInstanceId };
    const actionOrdinal = input.actionOrdinal ?? ordinal(scope, input.actionType, input.actorId);
    // 先算出行动键，按它把记录里那一行取回来：题面要的是「问出去那一刻」的台账，不是此刻这份。
    const key = actionKey(scope, input.actionType, input.actorId, actionOrdinal);
    const remembered = await stores.actions.find(key);
    const request: ActionRequest = {
      scope,
      actionType: input.actionType,
      actorId: input.actorId,
      actionOrdinal,
      preset: input.preset ?? presetOf(input.actionType),
      context: turnContextOf({
        state,
        // 记录里留着当时那个记号，按它取回那一刻的台账：断了再起时这份是整份铺回来的，
        // 比那一刻长出好几条，照整份取就不是这一问当初看到的那一份了。第一次问没有记号，此刻这份就是当时那份。
        process: facts.factsFor(input.actorId, remembered?.ledgerSeq),
        playerId: input.actorId,
        task: input.task,
        skill: skillFor(state, input.actorId, input.scenario),
        candidates,
        extra: input.extra,
      }),
      schema: shape.schema,
    };

    const outcome = await once(request, key, remembered, facts.lastSeq(), input.control);
    taken.push(outcome);

    // 形状已经由 schema 卡过，认领只是把 unknown 收回形状名对应的那个类型。
    const toPlayerId = (seatNo: number): string => index.toPlayerId(seatNo);
    const value = shape.toCore(outcome.decision, toPlayerId) as DecisionShapes[K];

    // 记在答完之后：这一次提问的可见事实在问出去那一刻就定住了，台账往后长不该渗回去。
    const fact = input.fact?.(value);
    if (fact) await record(key, fact);

    return value;
  }

  return {
    observe(state) {
      current = state;
    },
    outcomes: () => taken,

    async recordFlow(state, event) {
      if ((await replayingKeys()).size > 0) return;
      const facts = await ledgerNow();
      const phase = event.phase ?? nodeNameOf(state.phaseInstanceId);
      await facts.add(
        `${state.phaseInstanceId}/flow/${phase}/${event.key}`,
        state.day,
        event.text,
        event.audience ?? state.players.map((player) => player.id),
        event.kind ?? EVENT_KINDS.SYSTEM,
      );
    },

    async recordBallot(ballot) {
      const key = `${stateNow().phaseInstanceId}/ballot/${ballot.round}`;
      await record(key, publicFact(EVENT_KINDS.BALLOT, ballotText(ballot, seatNoOf)));
    },

    async runForSheriff(playerId) {
      return ask({
        actionType: ACTION_TYPES.SHERIFF_CANDIDACY,
        actorId: playerId,
        task: '决定是否上警竞选警长。',
        shape: 'yesOrNo',
      });
    },

    async withdraw(playerId) {
      return ask({
        actionType: ACTION_TYPES.SHERIFF_WITHDRAW,
        actorId: playerId,
        task: '要不要退水退出竞选。退水之后既不能被选，也没有票。',
        shape: 'yesOrNo',
      });
    },

    async speak(round, playerId, order) {
      return ask({
        actionType: ACTION_TYPES.SPEECH,
        actorId: playerId,
        task: SPEECH_TASKS[round],
        shape: 'speech',
        scenario: 'day_speech',
        extra: [`本轮发言顺序：${order.map((id) => `${seatNoOf(id)} 号`).join('、')}。`],
        fact: (content) =>
          publicFact(
            EVENT_KINDS.PUBLIC_SPEECH,
            `${seatNoOf(playerId)} 号发言：${oneLine(content)}`,
          ),
      });
    },

    // 这一问自己不留事实：一轮投票是并发问的，答完只是各自的落点，谁赢由 Core 收齐后计票。
    // 同轮投票期间不可见，收齐计票后才由 Core 发布。
    async vote(round, playerId, candidates) {
      return ask({
        actionType: ACTION_TYPES.VOTE,
        actorId: playerId,
        task: BALLOT_TASKS[round],
        shape: 'seatOrNone',
        scenario: 'vote',
        candidates,
        extra: ['投空就是弃票。'],
      });
    },

    async chooseSpeechSide(sheriffId) {
      return ask({
        actionType: ACTION_TYPES.SHERIFF_DECIDE_ORDER,
        actorId: sheriffId,
        task: '决定今天从你的哪一边开始发言。left 是逆时针，right 是顺时针。',
        shape: 'speechSide',
        scenario: 'sheriff_decide_order',
        fact: (side) =>
          publicFact(
            EVENT_KINDS.SHERIFF,
            `警长 ${seatNoOf(sheriffId)} 号决定从${side === 'left' ? '左' : '右'}边开始。`,
          ),
      });
    },

    async decideBadge(sheriffId, candidates) {
      return ask({
        actionType: ACTION_TYPES.SHERIFF_TRANSFER,
        actorId: sheriffId,
        task: '你出局了，决定警徽交给谁，还是撕掉。',
        shape: 'badgeDecision',
        candidates,
        fact: (decision) =>
          publicFact(
            EVENT_KINDS.SHERIFF,
            decision.kind === 'transfer'
              ? `${seatNoOf(sheriffId)} 号把警徽交给了 ${seatNoOf(decision.toId)} 号。`
              : `${seatNoOf(sheriffId)} 号撕掉了警徽。`,
          ),
      });
    },

    // 商议发言也走发言的形状，只是台词落在狼队频道上：同一夜狼与狼之间是明牌，
    // 对场上其他人等于没说。轮到谁说话时，前面的狼说的话已经在台账里，他读得到。
    async wolfSpeech(wolfId, round, order) {
      return ask({
        actionType: ACTION_TYPES.SPEECH,
        actorId: wolfId,
        task: `狼队商议第 ${round} 轮，轮到你说话。`,
        shape: 'speech',
        preset: 'quick',
        extra: [
          `本轮发言顺序：${order.map((id) => `${seatNoOf(id)} 号`).join('、')}。`,
          '你说的话只有狼队看得到，会进后面发言者的上下文。',
          '只讨论当前刀口和紧接着的分工，优先用 2—4 句话说清。已有共识简短确认，有新增信息再调整；不要重复队友的整套计划，也不要预演数日后的分支。',
        ],
        fact: (content) =>
          wolfFact(EVENT_KINDS.WOLF_SPEECH, `${seatNoOf(wolfId)} 号商议发言：${oneLine(content)}`),
      });
    },

    async wolfProposal(wolfId, candidates) {
      return ask({
        actionType: ACTION_TYPES.WOLF_PROPOSAL,
        actorId: wolfId,
        task: '决定今晚狼队刀谁。不刀也是合法的一票，队里取众数。',
        shape: 'seatOrNone',
        scenario: 'night_action',
        candidates,
        extra: ['狼队各提各的，队里取众数，你看不到别的狼提了谁。'],
      });
    },

    async guardProtect(guardId, candidates) {
      return ask({
        actionType: ACTION_TYPES.GUARD_PROTECT,
        actorId: guardId,
        task: '决定今晚守护谁。守护挡住狼刀。',
        shape: 'seatOrNone',
        scenario: 'night_action',
        candidates,
      });
    },

    async seerCheck(seerId, candidates) {
      return ask({
        actionType: ACTION_TYPES.SEER_CHECK,
        actorId: seerId,
        task: '决定今晚查验谁。你今晚看到的结果，明天只能靠你自己说出去。',
        shape: 'seat',
        scenario: 'night_action',
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
        scenario: 'night_action',
        candidates: poisonCandidates,
        antidoteAllowed: canSave,
        extra: [
          killTargetId === null
            ? '你今晚看不到刀口。'
            : selfTarget
              ? '今晚的刀口是你自己，解药救不了自己。'
              : `今晚的刀口是 ${playerOf(state, killTargetId).seatNo} 号。`,
          canSave
            ? '解药只能用在今晚的刀口上，毒药可以毒场上除你之外的任何一个还活着的人。'
            : '毒药可以毒场上除你之外的任何一个还活着的人。',
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

    async chooseBlaster(wolfIds, window) {
      const state = stateNow();
      const scope = { gameId: state.gameId, phaseInstanceId: state.phaseInstanceId };
      // 恢复跳过窗口也要消耗序号，后面的 PK 才不会读到前一轮行动。
      const ordinals = new Map(
        wolfIds.map((id) => [id, ordinal(scope, ACTION_TYPES.WOLF_EXPLODE, id)]),
      );
      const resuming = window === 'campaign_resume' || window === 'campaign_resume_pk';
      const result = await chooseBlaster(
        stores.checkpoints,
        JSON.stringify([state.gameId, state.phaseInstanceId, 'blast', window]),
        wolfIds,
        (wolfId, control) =>
          ask({
            actionType: ACTION_TYPES.WOLF_EXPLODE,
            actorId: wolfId,
            actionOrdinal: ordinals.get(wolfId),
            control,
            task: resuming
              ? '决定是否自爆。自爆会出局并使警徽流失；完成尚未处理的死讯和技能结算后入夜。'
              : '决定是否自爆。自爆会出局并跳过当天剩余的发言和放逐；完成尚未处理的死讯和技能结算后入夜。',
            shape: 'yesOrNo',
          }),
      );
      const replayed = await replayingKeys();
      const keys = new Set(
        wolfIds.flatMap((id) => {
          const key = actionKey(scope, ACTION_TYPES.WOLF_EXPLODE, id, ordinals.get(id)!);
          return replayed.delete(key) ? [key] : [];
        }),
      );
      if (keys.size > 0) {
        const saved = await stores.actions.list(state.gameId);
        taken.push(
          ...saved
            .filter((action) => keys.has(action.actionKey) && action.status === 'done')
            .map((action) => action.outcome as TurnOutcome),
        );
      }
      return result;
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
