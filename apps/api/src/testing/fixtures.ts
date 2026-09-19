import { ROLES } from '@werewolf/shared';
import type { GameSetup } from '../boards/setup';
import type { ActionProvider } from '../core/actions';
import { factionOf, type DealableRole } from '../core/roles';
import { createGameState, patchPlayer, type GameState, type PlayerState } from '../core/state';

/** 造 n 人局，玩家 id 是 p1、p2……boardId 只为凑快照的类型，跟座位无关。 */
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

/** 取某名玩家，没有就抛错——用例里写错 id 要当场看得见。 */
export function playerOf(state: GameState, playerId: string): PlayerState {
  const found = state.players.find((player) => player.id === playerId);
  if (!found) throw new Error(`局内没有 ${playerId}`);
  return found;
}

/**
 * 给指名的那几个人换角色，其余原样，阵营跟着一起换——只改 role 会摆出一手自相矛盾的牌。
 * 要单独摆改过阵营的局面，用 patchPlayer。
 */
export function withRoles(
  state: GameState,
  roles: Readonly<Record<string, DealableRole>>,
): GameState {
  return Object.entries(roles).reduce(
    (patched, [playerId, role]) =>
      patchPlayer(patched, playerId, { role, faction: factionOf(role) }),
    state,
  );
}

function notConfigured(method: string): never {
  throw new Error(`用例没有配置 ${method}`);
}

/** 按答案表投票，表里没有的人被问到就直接失败。不写全投某某的兜底：投票者集合就是被验的东西。 */
export function ballotOf(answers: Record<string, string | null>) {
  return async (turn: string, playerId: string): Promise<string | null> => {
    if (!(playerId in answers)) throw new Error(`${turn} 轮不该问 ${playerId} 要票`);
    return answers[playerId];
  };
}

/** 可局部覆盖的行动提供者，模拟玩家的决定；没覆盖的方法一律抛错，免得用例没走到预期分支也通过。 */
export function stubActions(overrides: Partial<ActionProvider> = {}): ActionProvider {
  return {
    runForSheriff: async () => notConfigured('runForSheriff'),
    withdraw: async () => notConfigured('withdraw'),
    speak: async () => notConfigured('speak'),
    vote: async () => notConfigured('vote'),
    chooseSpeechSide: async () => notConfigured('chooseSpeechSide'),
    decideBadge: async () => notConfigured('decideBadge'),
    wolfProposal: async () => notConfigured('wolfProposal'),
    guardProtect: async () => notConfigured('guardProtect'),
    seerCheck: async () => notConfigured('seerCheck'),
    witchDecision: async () => notConfigured('witchDecision'),
    hunterShot: async () => notConfigured('hunterShot'),
    wolfKingShot: async () => notConfigured('wolfKingShot'),
    wolfBlast: async () => notConfigured('wolfBlast'),
    whiteWolfTake: async () => notConfigured('whiteWolfTake'),
    ...overrides,
  };
}
