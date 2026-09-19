import { ROLES } from '@werewolf/shared';
import type { RandomSource } from '../../boards/deal';
import type { ActionProvider } from '../actions';
import type { NightDeath } from '../day/announce';
import type { DealableRole } from '../roles';
import { alivePlayers, patchPlayer, type GameState, type PlayerState } from '../state';
import { decideGuard } from '../skills/guard';
import { decideSeerCheck, type SeerCheck } from '../skills/seer';
import { decideWitch } from '../skills/witch';
import { decideWolfKill } from '../skills/werewolf';
import { resolveNight } from './resolve';

export interface NightInput {
  /** 入夜时的状态，玩家还都算活着——今晨出局的人天亮时已经不在场上了。 */
  state: GameState;
  actions: ActionProvider;
  /** 狼队提刀并列时的随机源。 */
  random: RandomSource;
}

export interface NightResult {
  /** 落了用药、守护与查验状态位的状态。生死没动，那步交给 announceDay。 */
  state: GameState;
  /** 今晨要公布的死者，可直接喂给 announceDay；空数组就是平安夜。 */
  deaths: NightDeath[];
  /** 本夜的查验；没有预言家或他没得验时为 null。 */
  check: SeerCheck | null;
}

/**
 * 走完一夜：狼队提刀 → 守卫守护 → 女巫用药 → 预言家查验 → 结算。
 *
 * 顺序是规则要求：狼刀在女巫之前，女巫才看得到刀口；守卫与女巫互相看不到对方守谁，
 * 会撞在同一个人身上，结算按同守同救。
 *
 * 生死不在这夜落下：被刀的人要等天亮公布死讯才出局，女巫若是刀口照样睁眼，救不了自己但毒药照用。
 * 各步的状态位一律读入夜时的值，不被这一夜自己的决定改掉。
 */
export async function runNight(input: NightInput): Promise<NightResult> {
  const { actions, random, state } = input;

  const wolfTargetId = await decideWolfKill(state, actions, random);

  const guard = aliveWithRole(state, ROLES.GUARD);
  const guardTargetId = await decideGuard(guard, state, actions);

  const witch = aliveWithRole(state, ROLES.WITCH);
  const witchAction = await decideWitch(witch, state, wolfTargetId, actions);

  const seer = aliveWithRole(state, ROLES.SEER);
  const check = await decideSeerCheck(seer, state, actions);

  let next = state;
  if (guard !== null) {
    next = patchPlayer(next, guard.id, { guardedOn: guardTargetId });
  }
  if (witch !== null) {
    next = patchPlayer(next, witch.id, {
      hasAntidoteUsed: witch.hasAntidoteUsed || witchAction.antidoteTargetId !== null,
      hasPoisonUsed: witch.hasPoisonUsed || witchAction.poisonTargetId !== null,
    });
  }
  if (seer !== null && check !== null) {
    next = patchPlayer(next, seer.id, { checkedIds: [...seer.checkedIds, check.targetId] });
  }

  return {
    state: next,
    deaths: resolveNight({
      wolfTargetId,
      guardTargetId,
      antidoteTargetId: witchAction.antidoteTargetId,
      poisonTargetId: witchAction.poisonTargetId,
    }),
    check,
  };
}

/** 场上还活着的某个角色；这些板子里每个角色至多一张，找到就是唯一一个。 */
function aliveWithRole(state: GameState, role: DealableRole): PlayerState | null {
  return alivePlayers(state).find((player) => player.role === role) ?? null;
}
