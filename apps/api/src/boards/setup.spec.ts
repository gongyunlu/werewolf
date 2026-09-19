import { ALL_BOARDS, handOf, type BoardId } from './boards';
import type { RandomSource } from './deal';
import { createGameSetup } from './setup';

const alwaysFirst: RandomSource = () => 0;

function setupOf(boardId: BoardId, gameId = 'g1') {
  return createGameSetup({ gameId, boardId, random: alwaysFirst });
}

describe('建局快照', () => {
  it('座位号从 1 起连续、不重复，长度等于板子的人数', () => {
    const setup = setupOf('12p_wolf_king');

    expect(setup.seats.map((seat) => seat.seatNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('发出去的牌就是板子里那手牌', () => {
    const dealt = setupOf('12p_white_wolf').seats.map((seat) => seat.role);
    const expected = handOf(ALL_BOARDS['12p_white_wolf']);

    expect([...dealt].toSorted()).toEqual(expected.toSorted());
  });

  it('板子身份、人数、警长与对局标识原样带出', () => {
    const setup = setupOf('12p_white_wolf', 'g-42');

    expect(setup.gameId).toBe('g-42');
    expect(setup.boardId).toBe('12p_white_wolf');
    expect(setup.hasSheriff).toBe(true);
    expect(setup.seats).toHaveLength(12);
  });

  it('快照里只有建局事实', () => {
    // 想往快照里塞 isAlive 这类运行态，或给座位补一个 faction，都必须先改这里。
    const setup = setupOf('12p_wolf_king');

    expect(Object.keys(setup).toSorted()).toEqual(['boardId', 'gameId', 'hasSheriff', 'seats']);
    expect(Object.keys(setup.seats[0]).toSorted()).toEqual(['role', 'seatNo']);
  });

  it('两次建局各算各的，不共用座位数组', () => {
    const first = setupOf('12p_wolf_king', 'g1');
    const second = setupOf('12p_wolf_king', 'g2');

    expect(first.seats).not.toBe(second.seats);
    expect(first.seats[0]).not.toBe(second.seats[0]);
    // 同一个随机源下结果相同，说明是新算的而不是共享的。
    expect(first.seats).toEqual(second.seats);
  });
});
