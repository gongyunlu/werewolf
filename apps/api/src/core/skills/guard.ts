import type { ActionProvider } from '../actions';
import { alivePlayers, type GameState, type PlayerState } from '../state';

/**
 * 守卫今夜守谁：存活玩家去掉昨夜守过的那个（空守不算守过谁），null 为空守，守自己也行。
 * 守卫看不到今晚狼刀，所以会和女巫同时护住一个人，结算按同守同救。
 */
export async function decideGuard(
  guard: PlayerState | null,
  state: GameState,
  actions: ActionProvider,
): Promise<string | null> {
  if (guard === null) return null;

  const candidates = alivePlayers(state).filter((player) => player.id !== guard.guardedOn);
  const target = await actions.guardProtect(
    guard.id,
    candidates.map((player) => player.id),
  );
  if (target !== null && !candidates.some((player) => player.id === target)) {
    throw new Error(`守卫只能守护存活玩家，且不能连着两夜守同一个：${target}`);
  }

  return target;
}
