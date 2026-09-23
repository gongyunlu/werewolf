import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import { makeState, playerOf, stubActions, withRoles } from '../../testing/fixtures';
import { runBlastWindow } from './self-destruct';

/** 场上还站着谁，按座位号。 */
function aliveIds(state: { players: readonly { id: string; isAlive: boolean }[] }): string[] {
  return state.players.filter((player) => player.isAlive).map((player) => player.id);
}

describe('自爆窗口', () => {
  it('一只狼失败后等待其他自爆回答收尾再返回失败', async () => {
    let release!: (value: boolean) => void;
    const slow = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const failed = jest.fn();
    const state = withRoles(makeState(6), { p1: ROLES.WEREWOLF, p2: ROLES.WEREWOLF });
    const result = runBlastWindow(
      state,
      'day',
      stubActions({
        wolfBlast: async (id) => {
          if (id === 'p1') throw new Error('自爆回答失败');
          return slow;
        },
      }),
    ).catch(failed);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(failed).not.toHaveBeenCalled();
    release(false);
    await result;
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: '自爆回答失败' }));
  });

  it('白狼王带人前已经观察到自己出局', async () => {
    const state = withRoles(makeState(6), {
      p1: ROLES.WHITE_WOLF,
      p2: ROLES.WEREWOLF,
      p3: ROLES.SEER,
    });
    let current = state;
    await runBlastWindow(
      state,
      'day',
      stubActions({
        wolfBlast: async (id) => id === 'p1',
        whiteWolfTake: async () => {
          expect(playerOf(current, 'p1').isAlive).toBe(false);
          return null;
        },
      }),
      (next) => {
        current = next;
      },
    );
  });

  it('并行问狼队全员，只有一只答是就他爆', async () => {
    const state = withRoles(makeState(6), {
      p2: ROLES.WEREWOLF,
      p4: ROLES.WEREWOLF,
      p5: ROLES.WOLF_KING,
    });
    const asked: string[] = [];
    const actions = stubActions({
      wolfBlast: async (wolfId) => {
        asked.push(wolfId);
        return wolfId === 'p4';
      },
    });

    const result = await runBlastWindow(state, 'day', actions);

    // 并行就是全问一遍，没有「答是就中断」这回事。
    expect(asked).toEqual(['p2', 'p4', 'p5']);
    expect(result.blasted).toBe(true);
    expect(playerOf(result.state, 'p4')).toMatchObject({
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.SELF_DESTRUCT,
    });
  });

  it('多只都想爆时由座位序定，不看谁先返回', async () => {
    const state = withRoles(makeState(6), {
      p2: ROLES.WEREWOLF,
      p4: ROLES.WEREWOLF,
      p5: ROLES.WOLF_KING,
    });
    const pack = ['p2', 'p4', 'p5'];
    // 座位越靠后答得越快：拿先返回的那个当赢家就会挑中 p5。
    const actions = stubActions({
      wolfBlast: async (wolfId) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(true), (pack.length - pack.indexOf(wolfId)) * 30),
        ),
    });

    const result = await runBlastWindow(state, 'day', actions);

    expect(playerOf(result.state, 'p2').isAlive).toBe(false);
    expect(playerOf(result.state, 'p4').isAlive).toBe(true);
    expect(playerOf(result.state, 'p5').isAlive).toBe(true);
  });

  it('没人自爆就原样交回', async () => {
    const state = withRoles(makeState(6), { p2: ROLES.WEREWOLF });
    const actions = stubActions({ wolfBlast: async () => false });

    const result = await runBlastWindow(state, 'day', actions);

    expect(result.blasted).toBe(false);
    expect(result.state).toBe(state);
  });

  it('狼队频道里没人就不问', async () => {
    // makeState 全是平民；stubActions 没配 wolfBlast，真问到就会失败。
    const state = makeState(6);

    expect(await runBlastWindow(state, 'day', stubActions())).toEqual({ state, blasted: false });
  });

  it('只有竞选续轮才是 resuming', async () => {
    const state = withRoles(makeState(6), { p2: ROLES.WEREWOLF });
    const flags: boolean[] = [];
    const actions = stubActions({
      wolfBlast: async (_wolfId, resuming) => {
        flags.push(resuming);
        return false;
      },
    });

    await runBlastWindow(state, 'campaign', actions);
    await runBlastWindow(state, 'campaign_resume', actions);
    await runBlastWindow(state, 'day', actions);

    expect(flags).toEqual([false, true, false]);
  });

  it('普通狼人自爆只带走自己', async () => {
    const state = withRoles(makeState(6), { p2: ROLES.WEREWOLF, p3: ROLES.WHITE_WOLF });
    // 没配 whiteWolfTake：爆的是普通狼，不该问白狼王那一手。
    const actions = stubActions({ wolfBlast: async (wolfId) => wolfId === 'p2' });

    const result = await runBlastWindow(state, 'day', actions);

    expect(result.blasted).toBe(true);
    expect(aliveIds(result.state)).toEqual(['p1', 'p3', 'p4', 'p5', 'p6']);
  });

  it('白狼王自爆顺手带走一个人', async () => {
    const state = withRoles(makeState(6), {
      p1: ROLES.SEER,
      p2: ROLES.WEREWOLF,
      p3: ROLES.WHITE_WOLF,
    });
    const actions = stubActions({
      wolfBlast: async (wolfId) => wolfId === 'p3',
      whiteWolfTake: async () => 'p5',
    });

    const result = await runBlastWindow(state, 'day', actions);

    expect(playerOf(result.state, 'p3').deathCause).toBe(DEATH_CAUSES.SELF_DESTRUCT);
    expect(playerOf(result.state, 'p5')).toMatchObject({
      isAlive: false,
      deathCause: DEATH_CAUSES.WHITE_WOLF_TAKE,
    });
  });

  it('被白狼王带走的狼王带不了人', async () => {
    const state = withRoles(makeState(6), {
      p1: ROLES.SEER,
      p2: ROLES.WEREWOLF,
      p3: ROLES.WHITE_WOLF,
      p4: ROLES.WOLF_KING,
    });
    // 没配 wolfKingShot：狼王是被自爆带走的，不该有带人这一手。
    const actions = stubActions({
      wolfBlast: async (wolfId) => wolfId === 'p3',
      whiteWolfTake: async () => 'p4',
    });

    const result = await runBlastWindow(state, 'day', actions);

    expect(playerOf(result.state, 'p4')).toMatchObject({
      isAlive: false,
      deathCause: DEATH_CAUSES.WHITE_WOLF_TAKE,
    });
  });

  it('自爆的是警长，警徽当场交出去', async () => {
    // 神职和平民各留一个活口，不然爆一只狼就分出了胜负，轮不到接徽那一问。
    const state = withRoles(
      { ...makeState(6), sheriffId: 'p2' },
      {
        p1: ROLES.SEER,
        p2: ROLES.WEREWOLF,
        p6: ROLES.WEREWOLF,
      },
    );
    const actions = stubActions({
      wolfBlast: async () => true,
      decideBadge: async () => ({ kind: 'transfer', toId: 'p4' }),
    });

    const result = await runBlastWindow(state, 'day', actions);

    // 拖到第二天早晨再交，可挑的人已经被夜里的刀口改过一遍。
    expect(result.state.sheriffId).toBe('p4');
  });

  it('死讯先交出去，接徽那一问看得见谁刚出局', async () => {
    // 警长就是那只白狼王：接徽那一问才排得上。
    const state = withRoles(
      { ...makeState(6), sheriffId: 'p3' },
      {
        p1: ROLES.SEER,
        p2: ROLES.WEREWOLF,
        p3: ROLES.WHITE_WOLF,
      },
    );
    let observed: string[] | null = null;
    let seenAtBadge: string[] | null = null;
    const actions = stubActions({
      wolfBlast: async (wolfId) => wolfId === 'p3',
      whiteWolfTake: async () => 'p5',
      decideBadge: async () => {
        seenAtBadge = observed;
        return { kind: 'tear' };
      },
    });

    await runBlastWindow(state, 'day', actions, (next) => {
      observed = aliveIds(next);
    });

    // 拿着入场那份局面，接徽的人挑出来的名单里还有刚爆的和刚被带走的。
    expect(seenAtBadge).toEqual(['p1', 'p2', 'p4', 'p6']);
  });

  it('带人之后分出胜负，警徽不必再问', async () => {
    // p4 是场上唯一的平民：白狼王把他带走就屠完边了。
    const state = withRoles(
      { ...makeState(6), sheriffId: 'p3' },
      {
        p1: ROLES.SEER,
        p2: ROLES.WEREWOLF,
        p3: ROLES.WHITE_WOLF,
        p5: ROLES.SEER,
        p6: ROLES.SEER,
      },
    );
    // 没配 decideBadge：胜负已经分出来了，这一问是白花的。
    const actions = stubActions({
      wolfBlast: async (wolfId) => wolfId === 'p3',
      whiteWolfTake: async () => 'p4',
    });

    const result = await runBlastWindow(state, 'day', actions);

    expect(playerOf(result.state, 'p4').deathCause).toBe(DEATH_CAUSES.WHITE_WOLF_TAKE);
    expect(result.state.sheriffId).toBe('p3');
  });

  it('白狼王已经是最后一狼就不带人', async () => {
    const state = withRoles(makeState(6), { p3: ROLES.WHITE_WOLF });
    // 没配 whiteWolfTake：最后一狼自爆，问了也是白问。
    const actions = stubActions({ wolfBlast: async () => true });

    const result = await runBlastWindow(state, 'day', actions);

    expect(aliveIds(result.state)).toEqual(['p1', 'p2', 'p4', 'p5', 'p6']);
  });
});
