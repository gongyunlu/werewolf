import { DEATH_CAUSES } from '@werewolf/shared';
import { ballotOf, makeState, stubActions } from '../../testing/fixtures';
import { runDay } from './run-day';

describe('走完一个白天', () => {
  it('有警长时：竞选、发言、放逐串成一条线', async () => {
    const actions = stubActions({
      runForSheriff: async (playerId) => playerId === 'p1' || playerId === 'p2',
      withdraw: async (playerId) => playerId === 'p2',
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      vote: ballotOf({ p1: 'p3', p2: 'p3', p3: 'p3', p4: 'p3', p5: 'p3', p6: 'p3' }),
    });

    const result = await runDay({
      state: makeState(6),
      actions,
      nightDeaths: [],
      minute: 22,
    });

    // p2 退水后只剩 p1 一个候选人，直接当选。
    expect(result.state.sheriffId).toBe('p1');
    expect(result.announcements).toEqual([]);
    // 警上发言从 2 号位起逆时针；白天从警长右边起顺时针，警长压轴。
    expect(result.speeches.map((speech) => [speech.turn, speech.seatNo])).toEqual([
      ['campaign', 2],
      ['campaign', 1],
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

  it('首夜死者照常上警，白天才不再有他', async () => {
    const actions = stubActions({
      runForSheriff: async (playerId) => playerId === 'p1' || playerId === 'p3',
      withdraw: async () => false,
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      vote: async (turn, playerId) =>
        (turn === 'campaign'
          ? ballotOf({ p2: 'p1', p4: 'p1', p5: 'p3', p6: 'p1' })
          : ballotOf({ p1: 'p4', p2: 'p4', p4: 'p1', p5: 'p4', p6: 'p4' }))(turn, playerId),
    });

    const result = await runDay({
      state: makeState(6),
      actions,
      nightDeaths: [{ playerId: 'p3', cause: DEATH_CAUSES.NIGHT_KILL }],
      minute: 22,
    });

    // 竞选时死讯还没公布，p3 照常上警、发言、被投票；白天他就不在发言队列里了。
    expect(result.speeches.map((speech) => [speech.turn, speech.seatNo])).toEqual([
      ['campaign', 1],
      ['campaign', 3],
      ['day', 2],
      ['day', 4],
      ['day', 5],
      ['day', 6],
      ['day', 1],
    ]);
    expect(result.announcements).toEqual([{ playerId: 'p3', seatNo: 3 }]);
    expect(result.exiledId).toBe('p4');
  });

  it('首夜死者当选警长时，警徽在公布死讯那一刻就有下落', async () => {
    const actions = stubActions({
      runForSheriff: async (playerId) => playerId === 'p1' || playerId === 'p2',
      withdraw: async () => false,
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      decideBadge: async () => ({ kind: 'transfer', toId: 'p2' }),
      vote: async (turn, playerId) =>
        (turn === 'campaign'
          ? ballotOf({ p3: 'p1', p4: 'p1', p5: 'p2', p6: 'p1' })
          : ballotOf({ p2: 'p3', p3: 'p3', p4: 'p4', p5: 'p4', p6: null }))(turn, playerId),
    });

    const result = await runDay({
      state: makeState(6),
      actions,
      nightDeaths: [{ playerId: 'p1', cause: DEATH_CAUSES.NIGHT_KILL }],
      minute: 22,
    });

    expect(result.state.sheriffId).toBe('p2');
    expect(result.speeches.map((speech) => [speech.turn, speech.seatNo])).toEqual([
      ['campaign', 2],
      ['campaign', 1],
      ['day', 3],
      ['day', 4],
      ['day', 5],
      ['day', 6],
      ['day', 2],
    ]);
    // p2 接手警徽后那 1.5 票把 p3 从平票里拉出来：不加权的话 2:2 得进 PK。
    expect(result.exiledId).toBe('p3');
  });

  it('第二天：警长夜里被刀，警徽当场易主', async () => {
    const actions = stubActions({
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      decideBadge: async () => ({ kind: 'transfer', toId: 'p3' }),
      vote: ballotOf({ p2: 'p2', p3: 'p2', p4: 'p5', p5: 'p5', p6: 'p2' }),
    });

    const result = await runDay({
      state: { ...makeState(6), day: 2, sheriffId: 'p1' },
      actions,
      nightDeaths: [{ playerId: 'p1', cause: DEATH_CAUSES.WITCH_POISON }],
      minute: 23,
    });

    // 竞选已经过去，没配 runForSheriff 也没被问到；p1 以警长身份进的白天，直到死讯落下。
    expect(result.speeches[0].turn).toBe('day');
    expect(result.state.sheriffId).toBe('p3');
    expect(result.speeches.map((speech) => speech.seatNo)).toEqual([4, 5, 6, 2, 3]);
    expect(result.exiledId).toBe('p2');
  });

  it('无警长时：死者占位、方向按单顺双逆', async () => {
    const actions = stubActions({
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      vote: ballotOf({ p1: 'p4', p3: 'p4', p4: 'p1', p6: 'p4' }),
    });

    const result = await runDay({
      state: makeState(6, false),
      actions,
      nightDeaths: [
        { playerId: 'p2', cause: DEATH_CAUSES.NIGHT_KILL },
        { playerId: 'p5', cause: DEATH_CAUSES.WITCH_POISON },
      ],
      minute: 23,
    });

    expect(result.state.sheriffId).toBeNull();
    expect(result.announcements.map((death) => death.seatNo)).toEqual([2, 5]);
    // 死者里座位号最小的 2 号位作起点，23 分的个位 3 是单数，顺时针顺延到 3 号位。
    expect(result.speeches.map((speech) => speech.seatNo)).toEqual([3, 4, 6, 1]);
    // 死人不参与投票，p2、p5 的名字没出现在票里；死因各按各的留在状态上。
    expect(result.exiledId).toBe('p4');
    expect(result.state.players.find((player) => player.id === 'p2')).toMatchObject({
      deathDay: 1,
      deathCause: DEATH_CAUSES.NIGHT_KILL,
    });
    expect(result.state.players.find((player) => player.id === 'p5')).toMatchObject({
      deathDay: 1,
      deathCause: DEATH_CAUSES.WITCH_POISON,
    });
  });
});
