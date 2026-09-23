import { type BoardId } from '../boards/boards';
import { createGameSetup } from '../boards/setup';
import { factionOf } from './roles';
import { alivePlayers, createGameState, patchPlayer } from './state';

const fixedRandom = () => 0;

function setupOf(boardId: BoardId) {
  return createGameSetup({ gameId: 'g-42', boardId, random: fixedRandom });
}

function stateOf(boardId: BoardId) {
  const setup = setupOf(boardId);
  return createGameState(
    setup,
    setup.seats.map((seat) => `p${seat.seatNo}`),
  );
}

describe('对局状态初始化', () => {
  it('座位号与角色原样取自建局快照', () => {
    const setup = setupOf('12p_wolf_king');
    const state = createGameState(
      setup,
      setup.seats.map((seat) => `p${seat.seatNo}`),
    );

    expect(state.players.map((player) => player.seatNo)).toEqual(
      setup.seats.map((seat) => seat.seatNo),
    );
    expect(state.players.map((player) => player.role)).toEqual(
      setup.seats.map((seat) => seat.role),
    );
  });

  it('玩家 id 与座位按名单下标对齐', () => {
    const setup = setupOf('12p_wolf_king');
    const state = createGameState(
      setup,
      setup.seats.map((_, index) => `p-${index}`),
    );

    expect(state.players[0].id).toBe('p-0');
    expect(state.players[11].id).toBe('p-11');
  });

  it('名单人数与座位数不符直接抛错', () => {
    const setup = setupOf('12p_wolf_king');

    expect(() => createGameState(setup, ['p1', 'p2'])).toThrow('玩家名单与座位数不符');
    expect(() => createGameState(setup, [])).toThrow('玩家名单与座位数不符');
  });

  it('阵营初值取 factionOf(role)', () => {
    const state = stateOf('12p_wolf_king');

    expect(state.players.map((player) => player.faction)).toEqual(
      state.players.map((player) => factionOf(player.role)),
    );
  });

  it('开局是第 1 天的夜晚', () => {
    const state = stateOf('12p_white_wolf');

    expect(state.day).toBe(1);
    expect(state.phaseInstanceId).toBe('node/0/init');
  });

  it('警长待竞选，本局有没有警长环节随快照', () => {
    const state = stateOf('12p_white_wolf');

    expect(state.gameId).toBe('g-42');
    expect(state.hasSheriff).toBe(true);
    expect(state.sheriffId).toBeNull();
  });

  it('每名玩家的运行态都是干净的初值', () => {
    const state = stateOf('12p_white_wolf');

    for (const player of state.players) {
      expect(player).toMatchObject({
        isAlive: true,
        deathDay: null,
        deathCause: null,
        hasAntidoteUsed: false,
        hasPoisonUsed: false,
      });
    }
  });

  it('两次初始化各算各的，不共用玩家数组', () => {
    const setup = setupOf('12p_wolf_king');
    const ids = setup.seats.map((seat) => `p${seat.seatNo}`);
    const first = createGameState(setup, ids);
    const second = createGameState(setup, ids);

    expect(first.players).not.toBe(second.players);
    expect(first.players[0]).not.toBe(second.players[0]);
    expect(first).toEqual(second);
  });
});

describe('改盘面', () => {
  it('只改指名的那个人，其余原样，传进来的状态不动', () => {
    const state = stateOf('12p_white_wolf');

    const next = patchPlayer(state, 'p3', { isAlive: false, deathDay: 2 });

    expect(next).not.toBe(state);
    expect(next.players[2]).toMatchObject({ isAlive: false, deathDay: 2 });
    expect(state.players[2]).toMatchObject({ isAlive: true, deathDay: null });
    expect(next.players.filter((_player, index) => index !== 2)).toEqual(
      state.players.filter((_player, index) => index !== 2),
    );
  });

  it('改一个局内没有的人直接抛错', () => {
    expect(() => patchPlayer(stateOf('12p_white_wolf'), 'p99', { isAlive: false })).toThrow(
      '局内没有 p99',
    );
  });
});

describe('数场上的人', () => {
  it('只数活着的，按座位顺序', () => {
    let state = stateOf('12p_white_wolf');
    state = patchPlayer(state, 'p2', { isAlive: false });
    state = patchPlayer(state, 'p7', { isAlive: false });

    expect(alivePlayers(state).map((player) => player.id)).toEqual([
      'p1',
      'p3',
      'p4',
      'p5',
      'p6',
      'p8',
      'p9',
      'p10',
      'p11',
      'p12',
    ]);
  });
});
