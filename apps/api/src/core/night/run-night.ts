import { ROLES } from '@werewolf/shared';
import type { RandomSource } from '../../boards/deal';
import type { ActionProvider } from '../actions';
import { seatNames, type FlowObserver } from '../flow';
import { inWolfChannel } from '../roles';
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
  /** 狼队抽发言顺序与提刀并列时的随机源。 */
  random: RandomSource;
  onFlow?: FlowObserver;
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
  const { actions, random, state, onFlow } = input;
  const say = (key: string, text: string, audience?: readonly string[]) =>
    onFlow?.(state, { key, text, audience });
  const hasRole = (role: DealableRole) => state.players.some((player) => player.role === role);

  await say('night-start', '天黑了，请所有玩家闭眼。');
  await say('wolves-open', '狼人请睁眼，确认同伴并商议今晚的袭击目标。');
  const wolfTargetId = await decideWolfKill(state, actions, random);
  await say(
    'wolves-result',
    wolfTargetId ? `狼队今晚选择袭击 ${seatNames(state, [wolfTargetId])}。` : '狼队今晚选择空刀。',
    alivePlayers(state)
      .filter((player) => inWolfChannel(player.role))
      .map((player) => player.id),
  );
  await say('wolves-close', '狼人请闭眼。');

  const guard = aliveWithRole(state, ROLES.GUARD);
  if (hasRole(ROLES.GUARD)) await say('guard-open', '守卫请睁眼，选择今晚要守护的玩家。');
  const guardTargetId = await decideGuard(guard, state, actions);
  if (guard)
    await say(
      'guard-result',
      guardTargetId
        ? `你今晚守护了 ${seatNames(state, [guardTargetId])}。`
        : '你今晚没有守护任何玩家。',
      [guard.id],
    );
  if (hasRole(ROLES.GUARD)) await say('guard-close', '守卫请闭眼。');

  const witch = aliveWithRole(state, ROLES.WITCH);
  if (hasRole(ROLES.WITCH)) await say('witch-open', '女巫请睁眼，决定是否使用解药或毒药。');
  if (witch && !witch.hasAntidoteUsed)
    await say(
      'witch-target',
      wolfTargetId
        ? `今晚被袭击的是 ${seatNames(state, [wolfTargetId])}。`
        : '今晚没有玩家被狼人袭击。',
      [witch.id],
    );
  const witchAction = await decideWitch(witch, state, wolfTargetId, actions);
  if (witch)
    await say(
      'witch-result',
      witchAction.antidoteTargetId
        ? `你使用解药救了 ${seatNames(state, [witchAction.antidoteTargetId])}。`
        : witchAction.poisonTargetId
          ? `你对 ${seatNames(state, [witchAction.poisonTargetId])} 使用了毒药。`
          : '你今晚没有使用药水。',
      [witch.id],
    );
  if (hasRole(ROLES.WITCH)) await say('witch-close', '女巫请闭眼。');

  const seer = aliveWithRole(state, ROLES.SEER);
  if (hasRole(ROLES.SEER)) await say('seer-open', '预言家请睁眼，选择你要查验的玩家。');
  const check = await decideSeerCheck(seer, state, actions);
  if (seer && check)
    await say(
      'seer-result',
      `查验结果：${seatNames(state, [check.targetId])} 是${check.result === 'werewolf' ? '狼人' : '好人'}。`,
      [seer.id],
    );
  if (hasRole(ROLES.SEER)) await say('seer-close', '预言家请闭眼。');

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
