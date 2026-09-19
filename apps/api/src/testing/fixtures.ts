import { ROLES } from '@werewolf/shared';
import type { GameSetup } from '../boards/setup';
import type { ActionProvider } from '../core/actions';
import { createGameState, type GameState } from '../core/state';

/**
 * 造一份指定人数的对局状态，玩家 id 是 p1、p2……
 *
 * boardId 只为满足快照的类型，座位与它无关——这些用例验的是白天流程，
 * 不需要真的发一手牌，人数小一点读起来更清楚。
 */
export function makeState(playerCount: number, hasSheriff = true): GameState {
  const seats = Array.from({ length: playerCount }, (_, index) => ({
    seatNo: index + 1,
    role: ROLES.VILLAGER,
  }));
  const setup: GameSetup = { gameId: 'g1', boardId: '12p_wolf_king', hasSheriff, seats };

  return createGameState(
    setup,
    seats.map((seat) => `p${seat.seatNo}`),
  );
}

function notConfigured(method: string): never {
  throw new Error(`用例没有配置 ${method}`);
}

/**
 * 按答案表投票；表里没有的人被问到就直接失败。
 *
 * 不用「其余人全投某某」这种兜底写法：投票者集合本身就是这些用例要验的东西，
 * 谁被问到必须逐一点名。
 */
export function ballotOf(answers: Record<string, string | null>) {
  return async (turn: string, playerId: string): Promise<string | null> => {
    if (!(playerId in answers)) throw new Error(`${turn} 轮不该问 ${playerId} 要票`);
    return answers[playerId];
  };
}

/**
 * 一套可局部覆盖的行动提供者，模拟玩家的决定。
 *
 * 没覆盖的方法一律抛错：安静的默认值会让用例在没走到预期分支时也显示通过，
 * 而「这个用例根本不该问到这里」本身就是一条值得断言的事实。
 */
export function stubActions(overrides: Partial<ActionProvider> = {}): ActionProvider {
  return {
    runForSheriff: async () => notConfigured('runForSheriff'),
    withdraw: async () => notConfigured('withdraw'),
    speak: async () => notConfigured('speak'),
    vote: async () => notConfigured('vote'),
    chooseSpeechSide: async () => notConfigured('chooseSpeechSide'),
    decideBadge: async () => notConfigured('decideBadge'),
    ...overrides,
  };
}
