import { ROLES, VISIBILITY_TYPES, type VisibilityType } from '@werewolf/shared';
import { inWolfChannel } from './roles';
import type { PlayerState } from './state';

/**
 * 判某个时点能看到什么的玩家状态。
 * 只取这三个字段：判历史要构造事实发生当时的观察者，与此刻不同，没必要伪造其余字段。
 */
export type Observer = Pick<PlayerState, 'role' | 'isAlive' | 'hasAntidoteUsed'>;

/**
 * 观察者此刻能看见的可见性集合。
 *
 * 一条事实对某人可见，要么它是公开的，要么此人在该事实发生那一刻持有对应的私密可见性。
 * 判历史要用当时的 Observer：女巫用掉解药后不再拿到新刀口，之前看到的不追回。
 * 致死事实算在死亡之前，所以死者知道自己出局了——但死因不公布，夜里死的不知道自己怎么死的。
 */
export function visibleVisibilities(observer: Observer): VisibilityType[] {
  // 出局者只剩旁观权：此后的公开事实照看，私密事实不给。死前看到的由调用方按当时的 Observer 判定。
  if (!observer.isAlive) return [VISIBILITY_TYPES.PUBLIC];

  const visibilities: VisibilityType[] = [VISIBILITY_TYPES.PUBLIC];

  // 按身份而非阵营：狼队信息对狼队频道成员可见，跟他跟谁一起赢无关。
  if (inWolfChannel(observer.role)) {
    visibilities.push(VISIBILITY_TYPES.WOLF, VISIBILITY_TYPES.WOLF_KILL);
  }
  if (observer.role === ROLES.SEER) {
    visibilities.push(VISIBILITY_TYPES.SEER);
  }
  if (observer.role === ROLES.WITCH) {
    visibilities.push(VISIBILITY_TYPES.WITCH);
    if (!observer.hasAntidoteUsed) visibilities.push(VISIBILITY_TYPES.WOLF_KILL);
  }

  return visibilities;
}
