import type { DeathCause, Faction, Phase } from '@werewolf/shared';
import type { PhaseInstanceId } from './identity';
import type { DealableRole } from './roles';

/** 一名玩家在对局中的状态。 */
export interface PlayerState {
  id: string;
  /** 座位号，从 1 起，一局内唯一。 */
  seatNo: number;
  role: DealableRole;
  /**
   * 当前阵营；发牌时取 factionOf(role)，被丘比特绑定后变为第三方。
   *
   * 只用于胜负判定。可见性不看阵营——隐狼属狼人阵营却与普通狼人互不可见，
   * 情侣改换阵营却不退出狼队频道，判据见 roles.ts 的 inWolfChannel。
   */
  faction: Faction;
  isAlive: boolean;
  /**
   * 死亡天数；存活为 null。
   *
   * 天粒度，不能拿它切「出局前 / 出局后」——同一天内可能有多条致死事实
   * （白天自爆、平票 PK 后在当天末尾放逐）。分段要用事件全序里的序号。
   */
  deathDay: number | null;
  /**
   * 死因；存活为 null。
   *
   * 上帝视角字段，不是一条带 visibility 的事实：法官不公布死因，夜里怎么死的
   * 死者自己也不知道。组装玩家上下文时不要照搬它，死者的「我出局了」只能由当时
   * 的公开事实推出，口径见 visibility.ts。
   */
  deathCause: DeathCause | null;
  /**
   * 解药是否已用掉。一局一次，用掉之后女巫不再看到狼队刀口，
   * 但已经看到过的刀口不会被追回——判断依据见 visibility.ts。
   */
  hasAntidoteUsed: boolean;
  /** 毒药是否已用掉。 */
  hasPoisonUsed: boolean;
}

/**
 * 对局状态：昼夜推进需要的最小状态。
 *
 * 只放「这局进行到哪了」和「玩家现在是什么样」，不放某个节点执行到一半的
 * 中间量（今晚的刀口、发言顺序等）——那些是节点的局部状态，归产生它们的规则。
 */
export interface GameState {
  gameId: string;
  /** 当前阶段实例身份，见 identity.ts。 */
  phaseInstanceId: PhaseInstanceId;
  /** 当前天数，从 1 起。 */
  day: number;
  phase: Phase;
  players: PlayerState[];
}
