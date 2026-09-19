import type { DealableRole } from '../core/roles';
import { ALL_BOARDS, handOf, type BoardId } from './boards';
import { dealRoles, type RandomSource } from './deal';

/** 一个座位分到的牌。 */
export interface SeatAssignment {
  readonly seatNo: number;
  readonly role: DealableRole;
}

/**
 * 建局快照：开局那一刻的座位分配、板子、有没有警长。
 * 只放开局那一刻的状态，进行中产生的中间量（今晚的刀口、发言顺序等）不进这里。
 */
export interface GameSetup {
  readonly gameId: string;
  readonly boardId: BoardId;
  readonly hasSheriff: boolean;
  readonly seats: readonly SeatAssignment[];
}

/** 取板子发牌，把结果连同座位号做成建局快照。 */
export function createGameSetup(input: {
  gameId: string;
  boardId: BoardId;
  random: RandomSource;
}): GameSetup {
  const board = ALL_BOARDS[input.boardId];
  const dealt = dealRoles(handOf(board), input.random);

  return {
    gameId: input.gameId,
    boardId: input.boardId,
    hasSheriff: board.hasSheriff,
    seats: dealt.map((role, index) => ({ seatNo: index + 1, role })),
  };
}
