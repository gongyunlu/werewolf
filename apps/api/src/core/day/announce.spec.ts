import { DEATH_CAUSES } from '@werewolf/shared';
import { makeState } from '../../testing/fixtures';
import { announceDay } from './announce';

describe('天亮公布死讯', () => {
  it('平安夜谁都不动', () => {
    const state = makeState(6);
    const result = announceDay(state, []);

    expect(result.deaths).toEqual([]);
    expect(result.state).toEqual(state);
    expect(state.players.every((player) => player.isAlive)).toBe(true);
  });

  it('把今晨的死者落到状态上', () => {
    const result = announceDay(makeState(6), [{ playerId: 'p3', cause: DEATH_CAUSES.NIGHT_KILL }]);

    expect(result.state.players.find((player) => player.id === 'p3')).toMatchObject({
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.NIGHT_KILL,
    });
    expect(result.deaths).toEqual([{ playerId: 'p3', seatNo: 3 }]);
  });

  it('公布出去的死讯不带死因', () => {
    const result = announceDay(makeState(6), [
      { playerId: 'p1', cause: DEATH_CAUSES.WITCH_POISON },
    ]);

    expect(Object.keys(result.deaths[0]).toSorted()).toEqual(['playerId', 'seatNo']);
    // 死因没丢，只是去了它该在的地方：法官不公布死因，它只留在状态上。
    expect(result.state.players.find((player) => player.id === 'p1')?.deathCause).toBe(
      DEATH_CAUSES.WITCH_POISON,
    );
  });

  it('没死的人连对象都不换', () => {
    const state = makeState(6);
    const result = announceDay(state, [{ playerId: 'p2', cause: DEATH_CAUSES.NIGHT_KILL }]);

    expect(result.state.players[0]).toBe(state.players[0]);
  });

  it('不修改传进来的状态', () => {
    const state = makeState(6);
    announceDay(state, [{ playerId: 'p2', cause: DEATH_CAUSES.NIGHT_KILL }]);

    expect(state.players.every((player) => player.isAlive)).toBe(true);
  });

  it('多人死亡按座位号升序公布', () => {
    const result = announceDay(makeState(6), [
      { playerId: 'p5', cause: DEATH_CAUSES.NIGHT_KILL },
      { playerId: 'p2', cause: DEATH_CAUSES.WITCH_POISON },
    ]);

    expect(result.deaths.map((death) => death.seatNo)).toEqual([2, 5]);
  });

  it('死讯里的玩家不在局内就抛错', () => {
    expect(() =>
      announceDay(makeState(6), [{ playerId: 'p9', cause: DEATH_CAUSES.NIGHT_KILL }]),
    ).toThrow('死讯里的玩家不在局内');
  });

  it('已经出局的人不会再公布一次死讯', () => {
    const state = makeState(6);
    const dead = state.players.map((player) =>
      player.id === 'p2' ? { ...player, isAlive: false } : player,
    );

    expect(() =>
      announceDay({ ...state, players: dead }, [
        { playerId: 'p2', cause: DEATH_CAUSES.NIGHT_KILL },
      ]),
    ).toThrow('已经出局的人不会再公布一次死讯');
  });

  it('同一名玩家在死讯里出现两次就抛错', () => {
    expect(() =>
      announceDay(makeState(6), [
        { playerId: 'p2', cause: DEATH_CAUSES.NIGHT_KILL },
        { playerId: 'p2', cause: DEATH_CAUSES.WITCH_POISON },
      ]),
    ).toThrow('死讯里重复出现同一名玩家');
  });
});
