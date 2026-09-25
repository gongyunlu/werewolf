import { DEATH_CAUSES, FACTIONS, ROLES } from '@werewolf/shared';
import { ballotOf, makeState, playerOf, stubActions, withRoles } from '../testing/fixtures';
import type { ActionProvider } from './actions';
import { nextPhaseInstanceId, nodeNameOf, phaseInstanceId } from './identity';
import { runGame, type StageAnchor } from './loop';
import type { GameState } from './state';

/**
 * 狼队提刀按夜给：每只狼自己数自己提了几回，同一夜提的都一样。
 * 同一夜里几只狼提的人不一样就要抽签，抽出来的是谁跟用例写死的那个对不上；
 * 列末那个人的目标之后一夜一夜接着用。
 */
function wolfTargetsByNight(targets: readonly string[]) {
  const asked = new Map<string, number>();

  return async (wolfId: string): Promise<string> => {
    const nth = (asked.get(wolfId) ?? 0) + 1;
    asked.set(wolfId, nth);
    return targets[Math.min(nth, targets.length) - 1];
  };
}

describe('推到终局', () => {
  it.each([true, false])('首夜中刀的 4 号在公布死讯前参与竞选，上警：%s', async (candidacy) => {
    const state = withRoles(makeState(6), {
      p1: ROLES.WHITE_WOLF,
      p3: ROLES.GUARD,
      p4: ROLES.SEER,
      p5: ROLES.WEREWOLF,
    });
    let current = state;
    const registered: string[] = [];
    const spoken: string[] = [];
    const campaignVoters: string[] = [];
    const flows: string[] = [];
    const badge = jest.fn(async () => ({ kind: 'transfer' as const, toId: 'p3' }));
    const actions = stubActions({
      wolfSpeech: async () => '刀 4 号。',
      wolfDiscussionContinues: async () => false,
      wolfProposal: wolfTargetsByNight(['p4', 'p2']),
      guardProtect: async () => null,
      seerCheck: async () => 'p3',
      runForSheriff: async (id) => {
        registered.push(id);
        expect(playerOf(current, 'p4').isAlive).toBe(true);
        return id === 'p5' || id === (candidacy ? 'p4' : 'p2');
      },
      withdraw: async () => false,
      wolfBlast: async () => false,
      speak: async (turn, id) => {
        spoken.push(`${turn}:${id}`);
        if (turn === 'campaign') expect(playerOf(current, 'p4').isAlive).toBe(true);
        if (turn === 'day') expect(playerOf(current, 'p4').isAlive).toBe(false);
        return `${turn}:${id}`;
      },
      vote: async (turn, id, candidates) => {
        if (turn === 'campaign') {
          campaignVoters.push(id);
          expect(playerOf(current, 'p4').isAlive).toBe(true);
          return candidacy ? 'p4' : 'p2';
        }
        expect(id).not.toBe('p4');
        expect(candidates).not.toContain('p4');
        return 'p6';
      },
      decideBadge: badge,
      chooseSpeechSide: async () => 'right',
    });

    const result = await runGame({
      state,
      actions,
      minuteOf: () => 22,
      observe: (next) => {
        current = next;
      },
      onFlow: async (_next, event) => {
        flows.push(event.key);
      },
    });

    expect(registered).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    expect(flows.indexOf('election-result')).toBeLessThan(flows.indexOf('dawn'));
    expect(spoken).not.toContain('day:p4');
    if (candidacy) {
      expect(spoken).toContain('campaign:p4');
      expect(badge).toHaveBeenCalledWith('p4', ['p1', 'p2', 'p3', 'p5', 'p6']);
    } else {
      expect(campaignVoters).toContain('p4');
    }
    expect(playerOf(result.state, 'p4')).toMatchObject({
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.NIGHT_KILL,
    });
    expect(result.winner).toBe(FACTIONS.WEREWOLF);
  });

  it('最后一狼夜里被毒死，仍先完成报名，公布死讯后终局', async () => {
    const state = withRoles(makeState(6), {
      p1: ROLES.WEREWOLF,
      p2: ROLES.SEER,
      p3: ROLES.WITCH,
      p4: ROLES.GUARD,
    });
    const register = jest.fn(async () => false);
    const actions = stubActions({
      runForSheriff: register,
      wolfProposal: async () => 'p5',
      guardProtect: async () => null,
      seerCheck: async () => 'p1',
      witchDecision: async () => ({ kind: 'poison', targetId: 'p1' }),
    });

    const result = await runGame({ state, actions, minuteOf: () => 22 });

    expect(result.winner).toBe(FACTIONS.GOOD);
    expect(playerOf(result.state, 'p1').isAlive).toBe(false);
    expect(result.state.day).toBe(1);
    expect(result.state.sheriffId).toBeNull();
    expect(register.mock.calls).toHaveLength(6);
  });

  it('放逐狼王后他带走最后一个平民，狼人屠民获胜', async () => {
    const state = withRoles(makeState(6, false), {
      p1: ROLES.WOLF_KING,
      p2: ROLES.WEREWOLF,
      p3: ROLES.HUNTER,
      p6: ROLES.SEER,
    });
    const actions = stubActions({
      wolfSpeech: async () => '今晚听你们的。',
      wolfDiscussionContinues: async () => false,
      wolfProposal: async () => 'p4',
      seerCheck: async () => 'p1',
      wolfBlast: async () => false,
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      vote: ballotOf({ p1: 'p1', p2: 'p1', p3: 'p1', p5: 'p1', p6: 'p1' }),
      wolfKingShot: async () => 'p5',
    });

    const result = await runGame({ state, actions, minuteOf: () => 22 });

    expect(result.winner).toBe(FACTIONS.WEREWOLF);
    expect(playerOf(result.state, 'p1')).toMatchObject({ deathCause: DEATH_CAUSES.EXECUTION });
    expect(playerOf(result.state, 'p5')).toMatchObject({
      isAlive: false,
      deathCause: DEATH_CAUSES.WOLF_KING_SHOT,
    });
    expect(result.state.day).toBe(1);
  });

  it('放逐狼王带走警长：警徽当场结掉，候选名单里还有下半夜要死的人', async () => {
    // 关掉竞选、把警徽预置给 p1：这条要看的是放逐技能连锁之后的收尾，不是警长的来路。
    const state = withRoles(
      { ...makeState(6, false), sheriffId: 'p1' },
      {
        p2: ROLES.WOLF_KING,
        p3: ROLES.WEREWOLF,
        p5: ROLES.HUNTER,
        p6: ROLES.SEER,
      },
    );
    const asked: string[][] = [];
    const actions = stubActions({
      wolfSpeech: async () => '今晚听你们的。',
      wolfDiscussionContinues: async () => false,
      wolfProposal: wolfTargetsByNight(['p6', 'p4']),
      seerCheck: async () => 'p2',
      wolfBlast: async () => false,
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      vote: ballotOf({ p1: 'p2', p2: 'p2', p3: 'p2', p4: 'p2', p5: 'p2' }),
      wolfKingShot: async () => 'p1',
      decideBadge: async (_sheriffId, candidates) => {
        asked.push([...candidates]);
        return { kind: 'transfer', toId: 'p5' };
      },
    });

    const result = await runGame({ state, actions, minuteOf: () => 22 });

    expect(result.winner).toBe(FACTIONS.WEREWOLF);
    // p4 当晚就被狼刀，他还在候选名单里，说明移交算在放逐那一刻，没等到第二天早晨。
    expect(asked).toEqual([['p3', 'p4', 'p5']]);
    expect(result.state.sheriffId).toBe('p5');
  });

  it('被放逐的狼王兼警长：先开枪带走人，再交警徽', async () => {
    // 关掉竞选、把警徽预置给 p1：这条看的是死后技能与警徽的先后。
    const state = withRoles(
      { ...makeState(6, false), sheriffId: 'p1' },
      {
        p1: ROLES.WOLF_KING,
        p2: ROLES.WEREWOLF,
        p3: ROLES.HUNTER,
        p6: ROLES.SEER,
      },
    );
    const asked: string[][] = [];
    const actions = stubActions({
      wolfSpeech: async () => '今晚听你们的。',
      wolfDiscussionContinues: async () => false,
      wolfProposal: wolfTargetsByNight(['p6', 'p3']),
      seerCheck: async () => 'p2',
      wolfBlast: async () => false,
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      vote: ballotOf({ p1: 'p1', p2: 'p1', p3: 'p1', p4: 'p1', p5: 'p1' }),
      wolfKingShot: async () => 'p4',
      decideBadge: async (sheriffId, candidates) => {
        asked.push([sheriffId, ...candidates]);
        return { kind: 'transfer', toId: 'p5' };
      },
    });

    const result = await runGame({ state, actions, minuteOf: () => 22 });

    // p4 是先挨了狼王那一枪的，他不在候选名单里——警徽排在技能之后，不是之前。
    expect(asked).toEqual([['p1', 'p2', 'p3', 'p5']]);
    expect(result.state.sheriffId).toBe('p5');
  });

  it('放逐最后一狼、他又是警长：对局当场终结，警徽不再动', async () => {
    const state = withRoles(
      { ...makeState(6, false), sheriffId: 'p1' },
      {
        p1: ROLES.WEREWOLF,
        p2: ROLES.SEER,
        p3: ROLES.HUNTER,
      },
    );
    // 没配 decideBadge：终局了还去问警徽给谁，就会在这里失败。
    const actions = stubActions({
      wolfProposal: async () => 'p6',
      seerCheck: async () => 'p1',
      wolfBlast: async () => false,
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      vote: ballotOf({ p1: 'p1', p2: 'p1', p3: 'p1', p4: 'p1', p5: 'p1' }),
    });

    const result = await runGame({ state, actions, minuteOf: () => 22 });

    expect(result.winner).toBe(FACTIONS.GOOD);
    expect(playerOf(result.state, 'p1')).toMatchObject({ deathCause: DEATH_CAUSES.EXECUTION });
    // 警徽留在已经出局的 p1 身上：交给谁都不影响胜负，不为它多问一次。
    expect(result.state.sheriffId).toBe('p1');
  });

  it('第一天平安夜又没人出局，天数推进到第二天接着打', async () => {
    const state = withRoles(makeState(6, false), {
      p1: ROLES.WEREWOLF,
      p2: ROLES.SEER,
      p3: ROLES.WITCH,
      p4: ROLES.GUARD,
    });
    let night = 0;
    const actions = stubActions({
      wolfProposal: async () => {
        night += 1;
        return night === 1 ? null : 'p5';
      },
      guardProtect: async () => null,
      seerCheck: async () => (night === 1 ? 'p1' : 'p3'),
      witchDecision: async () =>
        night === 1 ? { kind: 'none' } : { kind: 'poison', targetId: 'p1' },
      wolfBlast: async () => false,
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      vote: async () => null,
    });

    const result = await runGame({ state, actions, minuteOf: () => 22 });

    expect(result.state.day).toBe(2);
    expect(result.winner).toBe(FACTIONS.GOOD);
    expect(playerOf(result.state, 'p1').isAlive).toBe(false);
    expect(playerOf(result.state, 'p5')).toMatchObject({
      isAlive: false,
      deathDay: 2,
      deathCause: DEATH_CAUSES.NIGHT_KILL,
    });
    // 天亮单独留锚点，第二夜的结果在第二次天亮公布后终局。
    expect(result.state.phaseInstanceId).toBe('node/6/dawn');
  });
});

/**
 * 两天的牌：一只狼、预言家、女巫、守卫、猎人、一个平民。
 * 头一夜刀掉猎人 p6，天亮他不开枪；第一天放逐女巫 p3，第二夜刀掉预言家 p2，
 * 第二天放逐狼 p1——两轮下来四格都走得到，终局也不在头一天。
 * 猎人摆在夜里那一刀上：天亮那一格要真问一句，接着跑才接得住这一格。
 */
function board(): GameState {
  return withRoles(makeState(6, false), {
    p1: ROLES.WEREWOLF,
    p2: ROLES.SEER,
    p3: ROLES.WITCH,
    p4: ROLES.GUARD,
    p5: ROLES.VILLAGER,
    p6: ROLES.HUNTER,
  });
}

/** 这一局的固定打法：全按局面里看得见的东西作答，同一问走到哪一遍都答同一个。 */
function plan(): Partial<ActionProvider> {
  return {
    // 三狼以上才轮得到商议，这里只有这一条线要验，说了什么都不影响刀口。
    wolfSpeech: async () => '今晚听你们的。',
    wolfDiscussionContinues: async () => false,
    // p6 还在就刀他，他没了就刀预言家 p2：恢复重跑时手里那份局面跟断的那一次一样，答案也就一样。
    wolfProposal: async (_wolfId, candidates) => (candidates.includes('p6') ? 'p6' : 'p2'),
    guardProtect: async () => null,
    // 头一夜查 p1，往后从还能查的人里挑头一个：同一个人不能查第二遍。
    seerCheck: async (_seerId, candidates) => (candidates.includes('p1') ? 'p1' : candidates[0]),
    witchDecision: async () => ({ kind: 'none' }),
    // 猎人挨了夜里的刀，天亮不开枪：这一格要真问一句，接着跑才接得住这一格。
    hunterShot: async () => null,
    chooseBlaster: async () => null,
    speak: async (turn, playerId) => `${turn}:${playerId}`,
    // 女巫 p3 还在就都投她；她出局了就顺着候选投第一个不是自己的人。
    vote: async (_turn, playerId, candidates) =>
      candidates.includes('p3') ? 'p3' : (candidates.find((id) => id !== playerId) ?? null),
  };
}

/** 三只狼、七名平民的牌：每晚狼队都提得出三个不同的平民，投票放逐的又是平民。 */
const PACK: readonly string[] = ['p1', 'p2', 'p3'];
const VILLAGERS = new Set(['p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12']);

function packBoard(): GameState {
  return withRoles(makeState(12, false), {
    p1: ROLES.WEREWOLF,
    p2: ROLES.WEREWOLF,
    p3: ROLES.WEREWOLF,
    p4: ROLES.SEER,
    p5: ROLES.WITCH,
  });
}

/** 三只狼按座位认领三个不同的平民：三票并列就得抽签，刀口由这一格的随机流定。 */
function packPlan(): Partial<ActionProvider> {
  return {
    ...plan(),
    wolfProposal: async (wolfId, candidates) =>
      candidates.filter((id) => VILLAGERS.has(id))[PACK.indexOf(wolfId)] ?? null,
    // 每天都放逐头一个还活着的平民：狼一只都不走，夜里的抽签才能一夜一夜接着来。
    vote: async (_turn, playerId, candidates) =>
      candidates.find((id) => VILLAGERS.has(id) && id !== playerId) ?? null,
  };
}

/**
 * 每次提问记一行，每个锚点也记一行（`#节点实例`）。
 * 一局里每一步都手写一遍转发太啰嗦，代理只做记录，转发还给原样那套动作。
 */
function loggingActions(inner: ActionProvider, log: string[]): ActionProvider {
  return new Proxy(inner, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;

      return (...args: unknown[]) => {
        log.push(`${String(property)} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);
        return (value as (...rest: unknown[]) => unknown)(...args);
      };
    },
  }) as ActionProvider;
}

/** 从整跑那份日志里截出某一格之后的那一段：接着跑就该只问这一段里的问题。 */
function tailFrom(full: readonly string[], anchor: StageAnchor): string[] {
  const at = full.indexOf(`#${anchor.phaseInstanceId}`);
  if (at < 0) throw new Error(`整跑里没有这一格：${anchor.phaseInstanceId}`);
  return full.slice(at);
}

/** 谁还活着。 */
function livesOf(state: GameState): boolean[] {
  return state.players.map((player) => player.isAlive);
}

/** 谁在第几天怎么出局的：这一局死的人凑起来是同一批，只看活没活着分不出刀口换没换过人。 */
function deathsOf(state: GameState): string[] {
  return state.players.map(
    (player) =>
      `${player.id} ${player.isAlive} ${player.deathDay ?? '-'} ${player.deathCause ?? '-'}`,
  );
}

describe('断点续跑', () => {
  /** 跑一局，把提问与锚点都记下来；resume 给了就从那一格接着跑。 */
  async function play(
    options: {
      resume?: StageAnchor;
      minuteOf?: (day: number) => number;
      board?: GameState;
      plan?: Partial<ActionProvider>;
    } = {},
  ) {
    const log: string[] = [];
    const anchors: StageAnchor[] = [];
    const actions = loggingActions(stubActions(options.plan ?? plan()), log);

    const result = await runGame({
      // 接着跑时交给它的是新开的一局的局面：局面该以锚点里那份为准。
      state: options.board ?? board(),
      actions,
      minuteOf: options.minuteOf ?? (() => 22),
      resume: options.resume,
      onStage: async (anchor) => {
        anchors.push(anchor);
        log.push(`#${anchor.phaseInstanceId}`);
      },
    });

    return { result, log, anchors };
  }

  it.each(['night', 'dawn', 'deathSkills', 'day', 'exileSkills'])(
    '从第一轮的 %s 那一格接着跑：前面那几格不重放，终局与整跑一样',
    async (stage) => {
      const full = await play();
      const anchor = full.anchors.find((item) => nodeNameOf(item.phaseInstanceId) === stage);
      if (!anchor) throw new Error(`整跑没走到 ${stage} 这一格`);

      const resumed = await play({ resume: anchor });

      // 接着跑那一格的序号跟锚点里的一模一样：重推一次，答过的那些提问就全换了键。
      expect(resumed.log[0]).toBe(`#${anchor.phaseInstanceId}`);
      expect(resumed.log).toEqual(tailFrom(full.log, anchor));
      expect(resumed.result.winner).toBe(full.result.winner);
      expect(livesOf(resumed.result.state)).toEqual(livesOf(full.result.state));
    },
  );

  it('锚点不在这一天的流程中：当场抛，不闷头从头跑一局', async () => {
    const full = await play();

    // 锚点是从库里取回来的，来路不明的行得挡在这一步，别拿它当进度使。
    const stale = { ...full.anchors[0], phaseInstanceId: phaseInstanceId(9, 'night_resolve') };

    await expect(play({ resume: stale })).rejects.toThrow('锚点不在这一天的流程中');
  });

  it('锚点里那份局面不在这一格上：当场抛，不拿错位的进度接着跑', async () => {
    const full = await play();
    const anchor = full.anchors.find((item) => nodeNameOf(item.phaseInstanceId) === 'day');
    if (!anchor) throw new Error('整跑没走到白天这一格');

    // 认格按行里那份、做键按局面里那份；两份对不上，跑起来的格与落下的锚点就分家了。
    const crossed = {
      ...anchor,
      state: { ...anchor.state, phaseInstanceId: phaseInstanceId(0, 'init') },
    };

    await expect(play({ resume: crossed })).rejects.toThrow('锚点里那份局面不在这一格上');
  });

  it('接着跑落在放逐技能那一格、这一格又没人可问：下一格另起一个新实例', async () => {
    const full = await play();
    const anchor = full.anchors.find((item) => nodeNameOf(item.phaseInstanceId) === 'exileSkills');
    if (!anchor) throw new Error('整跑没走到放逐技能这一格');

    // 没人被放逐就不进这一格，恢复标记得跟着这一轮作废；留着的话，第二天的夜间
    // 会顶着这一格的名字跑，从那儿起每一问的键都跟着换了名字。
    const resumed = await play({ resume: { ...anchor, input: { deaths: [] } } });

    expect(resumed.log[0]).toBe(`#${nextPhaseInstanceId(anchor.phaseInstanceId, 'night')}`);
  });

  it('恢复落在白天那一格：分钟数取锚点里那份，不重新问时钟', async () => {
    const full = await play({ minuteOf: () => 22 });
    const anchor = full.anchors.findLast((item) => nodeNameOf(item.phaseInstanceId) === 'day');
    if (!anchor) throw new Error('整跑没走到白天这一格');

    // 时钟在核心外面，换了分钟数这一局的发言方向就跟着换一套；接着跑要的还是断那一次那个。
    const resumed = await play({ resume: anchor, minuteOf: () => 99 });

    expect(resumed.log).toEqual(tailFrom(full.log, anchor));
  });

  it('狼队并列提刀：重进那一格抽回的是同一个数，后面几夜的刀口一路对得上', async () => {
    const full = await play({ board: packBoard(), plan: packPlan() });
    const anchor = full.anchors.find((item) => nodeNameOf(item.phaseInstanceId) === 'day');
    if (!anchor) throw new Error('整跑没走到白天这一格');

    // 抽签每夜抽一次，抽到的数只认那一格：换上按局铺一条流的写法，
    // 接着跑第二夜会抽到整跑头一夜抽过的那个数，从这一夜起刀口就换了人。
    const resumed = await play({ resume: anchor, board: packBoard(), plan: packPlan() });

    expect(full.result.winner).toBe(FACTIONS.WEREWOLF);
    // 七名平民一个不剩：四夜抽签一路抽歪的话，死的就不止这些、也不止这些人。
    expect(livesOf(full.result.state).filter((alive) => !alive)).toHaveLength(VILLAGERS.size);
    expect(deathsOf(resumed.result.state)).toEqual(deathsOf(full.result.state));
  });

  it('整跑不留锚点也照跑：这一跑没有下一段要接', async () => {
    const state = board();
    const actions = stubActions(plan());

    const result = await runGame({ state, actions, minuteOf: () => 22 });

    expect(result.winner).toBe(FACTIONS.GOOD);
    expect(result.state.day).toBe(2);
  });
});

describe('双爆后的夜间结算与恢复', () => {
  async function play(resume?: StageAnchor) {
    const state = withRoles(makeState(12), {
      p1: ROLES.WEREWOLF,
      p2: ROLES.WEREWOLF,
      p3: ROLES.WEREWOLF,
      p4: ROLES.HUNTER,
      p5: ROLES.SEER,
      p6: ROLES.GUARD,
      p7: ROLES.WITCH,
    });
    let current = state;
    const log: string[] = [];
    const anchors: StageAnchor[] = [];
    const actions = loggingActions(
      stubActions({
        wolfSpeech: async () => '按约定刀人。',
        wolfDiscussionContinues: async () => false,
        wolfProposal: async () => (current.day === 1 ? 'p4' : current.day === 2 ? 'p5' : 'p9'),
        guardProtect: async () => null,
        seerCheck: async (_id, candidates) => candidates[0],
        witchDecision: async () =>
          current.day === 3 ? { kind: 'poison', targetId: 'p3' } : { kind: 'none' },
        runForSheriff: async (id) => id === 'p5' || id === 'p6',
        wolfBlast: async (id, resuming) =>
          current.day === 1 ? id === 'p1' : resuming && id === 'p2',
        hunterShot: async () => {
          expect(playerOf(current, 'p1').deathCause).toBe(DEATH_CAUSES.SELF_DESTRUCT);
          expect(playerOf(current, 'p4').deathCause).toBe(DEATH_CAUSES.NIGHT_KILL);
          return 'p8';
        },
      }),
      log,
    );
    const result = await runGame({
      state,
      actions,
      resume,
      minuteOf: () => 22,
      observe: (next) => {
        current = next;
      },
      onStage: async (anchor) => {
        anchors.push(anchor);
        log.push(`#${anchor.phaseInstanceId}`);
      },
      onFlow: async (next, event) => {
        log.push(`${next.day}:${event.key}:${event.text}`);
      },
    });
    return { result, anchors, log };
  }

  it('首爆仍结算昨夜猎人，次日先二爆再公布死讯，第三天不再竞选', async () => {
    const { result, log } = await play();
    expect(result.winner).toBe(FACTIONS.GOOD);
    expect(result.state.day).toBe(3);
    expect(result.state.sheriffElectionSuspended).toBeNull();
    expect(result.state.sheriffElectionSettled).toBe(true);
    expect(result.state.sheriffId).toBeNull();
    expect(playerOf(result.state, 'p8').deathCause).toBe(DEATH_CAUSES.HUNTER_SHOT);
    const at = (prefix: string) => log.findIndex((line) => line.startsWith(prefix));
    expect(at('1:campaign-blast-result:')).toBeLessThan(at('1:dawn:'));
    expect(at('1:dawn:')).toBeLessThan(at('1:death-skill-p4:'));
    expect(at('1:death-skill-p4:')).toBeLessThan(at('2:daybreak:'));
    expect(at('2:campaign_resume-blast-result:')).toBeLessThan(at('2:dawn:'));
    expect(log.filter((line) => line.startsWith('runForSheriff '))).toHaveLength(12);
    expect(log.some((line) => line.includes('day-speech'))).toBe(false);
    expect(log.filter((line) => line.startsWith('2:dawn:'))).toEqual(['2:dawn:昨晚 5 号 倒牌。']);
  });

  it.each([
    [1, 'dawn'],
    [1, 'deathSkills'],
    [2, 'dawn'],
    [2, 'deathSkills'],
  ] as const)('从第 %s 天的 %s 恢复，不丢失夜间结果或自爆打断状态', async (day, stage) => {
    const full = await play();
    const anchor = full.anchors.find(
      (item) => item.state.day === day && nodeNameOf(item.phaseInstanceId) === stage,
    )!;
    const resumed = await play(anchor);
    expect(resumed.log).toEqual(tailFrom(full.log, anchor));
    expect(resumed.result).toEqual(full.result);
  });
});
