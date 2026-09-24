import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import { ballotOf, makeState, playerOf, stubActions, withRoles } from '../../testing/fixtures';
import type { GameState } from '../state';
import { announceDay, type NightDeath } from './announce';
import { runDay } from './run-day';

/** 天亮那段走完之后的状态：死讯落了地，runDay 从这里接手。 */
function afterDawn(state: GameState, deaths: readonly NightDeath[]): GameState {
  return announceDay(state, deaths).state;
}

describe('走完一个白天', () => {
  it('有警长时：常规发言与放逐串成一条线', async () => {
    const actions = stubActions({
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      vote: ballotOf({ p1: 'p3', p2: 'p3', p3: 'p3', p4: 'p3', p5: 'p3', p6: 'p3' }),
    });

    const result = await runDay({
      state: { ...makeState(6), sheriffId: 'p1' },
      actions,
      minute: 22,
    });

    expect(result.state.sheriffId).toBe('p1');
    // 白天从警长右边起顺时针，警长压轴。
    expect(result.speeches.map((speech) => [speech.turn, speech.seatNo])).toEqual([
      ['day', 2],
      ['day', 3],
      ['day', 4],
      ['day', 5],
      ['day', 6],
      ['day', 1],
    ]);
    expect(result.exiledId).toBe('p3');
    expect(result.state.players.find((player) => player.id === 'p3')).toMatchObject({
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.EXECUTION,
    });
  });

  it('已公布夜间死讯的人不进常规发言和放逐投票', async () => {
    const actions = stubActions({
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      vote: ballotOf({ p1: 'p2', p2: 'p2', p4: 'p2', p5: 'p2', p6: 'p2' }),
    });

    const result = await runDay({
      state: afterDawn({ ...makeState(6), sheriffId: 'p1' }, [
        { playerId: 'p3', cause: DEATH_CAUSES.NIGHT_KILL },
      ]),
      actions,
      minute: 22,
    });

    expect(result.state.sheriffId).toBe('p1');
    expect(result.speeches.map((speech) => [speech.turn, speech.seatNo])).toEqual([
      ['day', 2],
      ['day', 4],
      ['day', 5],
      ['day', 6],
      ['day', 1],
    ]);
    expect(result.exiledId).toBe('p2');
  });

  it('第二天：警长夜里被刀，警徽当场易主', async () => {
    const actions = stubActions({
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      decideBadge: async () => ({ kind: 'transfer', toId: 'p3' }),
      vote: ballotOf({ p2: 'p2', p3: 'p2', p4: 'p5', p5: 'p5', p6: 'p2' }),
    });

    const result = await runDay({
      state: afterDawn({ ...makeState(6), day: 2, sheriffId: 'p1' }, [
        { playerId: 'p1', cause: DEATH_CAUSES.WITCH_POISON },
      ]),
      actions,
      minute: 23,
    });

    // 竞选已经过去，没配 runForSheriff 也没被问到；警徽在发言之前就交到了 p3 手上。
    expect(result.speeches[0].turn).toBe('day');
    expect(result.state.sheriffId).toBe('p3');
    expect(result.speeches.map((speech) => speech.seatNo)).toEqual([4, 5, 6, 2, 3]);
    expect(result.exiledId).toBe('p2');
  });

  it('第二天：警徽易主后的 1.5 票把票型拉出平局', async () => {
    const actions = stubActions({
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      decideBadge: async () => ({ kind: 'transfer', toId: 'p2' }),
      vote: ballotOf({ p2: 'p3', p3: 'p3', p4: 'p4', p5: 'p4', p6: null }),
    });

    const result = await runDay({
      state: afterDawn({ ...makeState(6), day: 2, sheriffId: 'p1' }, [
        { playerId: 'p1', cause: DEATH_CAUSES.NIGHT_KILL },
      ]),
      actions,
      minute: 22,
    });

    expect(result.state.sheriffId).toBe('p2');
    // 不加权的话 p3、p4 各 2 票得进 PK；p2 接手警徽后那 1.5 票把 p3 拉了出来。
    expect(result.exiledId).toBe('p3');
  });

  it('白天自爆的警长当天就把警徽交出去', async () => {
    // 神职和平民各留一个活口，不然爆一只狼就分出了胜负，轮不到接徽那一问。
    const state = withRoles(
      { ...makeState(6), day: 2, sheriffId: 'p2' },
      {
        p1: ROLES.SEER,
        p2: ROLES.WEREWOLF,
        p6: ROLES.WEREWOLF,
      },
    );
    // 只配了自爆与警徽：这一天在自爆处结束，发言和投票都不该走到。
    const actions = stubActions({
      wolfBlast: async () => true,
      decideBadge: async () => ({ kind: 'transfer', toId: 'p4' }),
    });

    const result = await runDay({ state, actions, minute: 22 });

    expect(result.exiledId).toBeNull();
    expect(playerOf(result.state, 'p2').isAlive).toBe(false);
    // 移交不能拖到第二天早晨：那时可挑的人已经被夜里的刀口改过一遍。
    expect(result.state.sheriffId).toBe('p4');
  });

  it('当前警长，自爆那一问的局面上看得见', async () => {
    const state = withRoles(
      { ...makeState(6), sheriffId: 'p2' },
      {
        p1: ROLES.SEER,
        p2: ROLES.WEREWOLF,
        p6: ROLES.WEREWOLF,
      },
    );
    const observed: GameState[] = [];
    let blastSaw = '没交过局面';
    const actions = stubActions({
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      // 一个窗口把队里的狼挨个问一遍，只让 2 号自爆。
      wolfBlast: async (wolfId) => {
        if (wolfId !== 'p2') return false;
        const seen = observed.at(-1);
        blastSaw = seen === undefined ? '没交过局面' : `警长 ${seen.sheriffId ?? '空'}`;
        return true;
      },
      decideBadge: async () => ({ kind: 'tear' }),
    });

    const result = await runDay({
      state,
      actions,
      minute: 22,
      observe: (next) => observed.push(next),
    });

    // 只给入场那份局面，狼决定爆不爆的时候还不知道 2 号刚当选，那是它当天唯一的下场机会。
    expect(blastSaw).toBe('警长 p2');
    expect(result.state.sheriffId).toBeNull();
  });

  it('常规发言阶段不再开自爆窗口：一天只问一次，发言照走完', async () => {
    const state = withRoles({ ...makeState(6), day: 2, sheriffId: 'p1' }, { p4: ROLES.WEREWOLF });
    let blastCalls = 0;
    const spoken: string[] = [];
    const actions = stubActions({
      speak: async (_turn, playerId) => {
        spoken.push(playerId);
        return playerId;
      },
      // 第二次问起才肯爆：这一天只在常规发言之前问过一次，第二次不会来。
      wolfBlast: async () => {
        blastCalls += 1;
        return blastCalls > 1;
      },
      chooseSpeechSide: async () => 'right',
      vote: ballotOf({ p1: 'p2', p2: 'p2', p3: 'p2', p4: 'p2', p5: 'p2', p6: 'p2' }),
    });

    const result = await runDay({ state, actions, minute: 22 });

    expect(blastCalls).toBe(1);
    expect(spoken).toEqual(['p2', 'p3', 'p4', 'p5', 'p6', 'p1']);
    expect(playerOf(result.state, 'p4').isAlive).toBe(true);
    expect(result.exiledId).toBe('p2');
  });

  it('无警长时：死者占位、方向按单顺双逆', async () => {
    const actions = stubActions({
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      vote: ballotOf({ p1: 'p4', p3: 'p4', p4: 'p1', p6: 'p4' }),
    });

    const result = await runDay({
      state: afterDawn(makeState(6, false), [
        { playerId: 'p2', cause: DEATH_CAUSES.NIGHT_KILL },
        { playerId: 'p5', cause: DEATH_CAUSES.WITCH_POISON },
      ]),
      actions,
      minute: 25,
    });

    expect(result.state.sheriffId).toBeNull();
    // 死者里座位号最小的 2 号位作起点（25 分的个位 5 只定方向，起点让给死者），顺时针顺延到 3 号位。
    expect(result.speeches.map((speech) => speech.seatNo)).toEqual([3, 4, 6, 1]);
    // 死人不参与投票，p2、p5 的名字没出现在票里；死因各按各的留在状态上。
    expect(result.exiledId).toBe('p4');
    expect(result.state.players.find((player) => player.id === 'p2')).toMatchObject({
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.NIGHT_KILL,
    });
    expect(result.state.players.find((player) => player.id === 'p5')).toMatchObject({
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.WITCH_POISON,
    });
  });
});
