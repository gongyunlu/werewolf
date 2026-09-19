import type { DealableRole } from '../core/roles';
import { ALL_BOARDS, handOf, type BoardId } from './boards';
import { dealRoles, type RandomSource } from './deal';

/** 一个座位分到的牌。 */
export interface SeatAssignment {
  readonly seatNo: number;
  readonly role: DealableRole;
}

/**
 * 建局快照：开局那一刻的座位分配、板子、是否有警长。
 *
 * 只放开局那一刻的状态，不放游戏进行中产生的中间量（今晚的刀口、发言顺序等）——
 * 那些是节点的局部状态，归产生它们的规则。
 */
export interface GameSetup {
  readonly gameId: string;
  readonly boardId: BoardId;
  readonly hasSheriff: boolean;
  readonly seats: readonly SeatAssignment[];
}

/**
 * 建局：取板子、发牌，把结果连同座位号做成快照
 * @param input.gameId 游戏 ID
 * @param input.boardId 板子 ID
 * @param input.random 随机源
 * @returns 建局快照
 */
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
