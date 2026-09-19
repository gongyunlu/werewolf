import { ROLES, VISIBILITY_TYPES, type VisibilityType } from '@werewolf/shared';
import { inWolfChannel } from './roles';
import type { PlayerState } from './state';

/**
 * 观察时点上决定"能看到什么"的玩家状态。
 *
 * 单独取这三个字段而不是整个 PlayerState：历史投影需要构造事实**发生当时**的
 * 观察者，那时玩家是否存活、有没有用掉解药与此刻不同，没必要为此伪造其余字段。
 * PlayerState 结构上满足它，当前时刻直接传即可。
 */
export type Observer = Pick<PlayerState, 'role' | 'isAlive' | 'hasAntidoteUsed'>;

/**
 * 观察者此刻能看见的可见性集合。
 *
 * 口径：一条事实对某名玩家可见，当且仅当它是公开事实，或者该玩家在
 * **该事实发生的那一刻**持有对应的私密可见性。公开事实不设门槛，与生死无关。
 *
 * 所以判历史要用当时的 Observer，不能拿此刻的状态去判过去的事实：
 * 女巫用掉解药后不再获得新的刀口，但用药前已经看到的刀口不会被追回。
 * 死亡同理——出局即失去全部私密可见性，他死之前看到的不受影响。
 * 两条都由「按事实发生时的状态判定」结构性保证，不需要为女巫或死者写特例。
 *
 * 界定死亡时刻时，致死事实算在死亡之前；但这条只对**死亡这件事本身**成立——
 * 「p2 被放逐」发布在放逐生效之前，死者因此知道自己出局了。死因是另一回事：
 * 法官不公布死因，刀口给狼人与女巫、毒口给女巫，死者从来不在其中。所以夜里死的
 * 人记录里只有「我出局了」、没有「我怎么死的」，只有白天被放逐的才知道自己怎么
 * 出局的。这不是特例，是上面这条口径的直接结果，别把 PlayerState.deathCause
 * 当成死者看得到的事实。
 */
export function visibleVisibilities(observer: Observer): VisibilityType[] {
  // 出局者只剩旁观权：公开事实不设门槛，他仍能看到此后的公开发言、投票结果、
  // 最终胜负；此后的私密事实（狼队商议、刀口、查验）不给。他死之前看到的那些
  // 由调用方用「当时还活着」的 Observer 判定，自然保留。
  //
  // 投影时逐条推进 Observer，出局前的事实判为全可见、出局后只剩 public，
  // 「出局前 / 出局后」两段由此自动分开，不需要另写分段规则。
  if (!observer.isAlive) return [VISIBILITY_TYPES.PUBLIC];

  const visibilities: VisibilityType[] = [VISIBILITY_TYPES.PUBLIC];

  // 按身份而非按阵营判断：狼队信息对狼队频道的每个成员可见，与他跟谁一起赢无关。
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
