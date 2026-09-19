import { PHASES, type DeathCause, type Faction, type Phase } from '@werewolf/shared';
import type { GameSetup } from '../boards/setup';
import { phaseInstanceId, type PhaseInstanceId } from './identity';
import { factionOf, type DealableRole } from './roles';

/** 一名玩家在对局中的状态。 */
export interface PlayerState {
  id: string;
  /** 座位号，从 1 起，一局内唯一。 */
  seatNo: number;
  role: DealableRole;
  /**
   * 当前阵营，发牌时取 factionOf(role)，情侣绑定后改为第三方。
   * 只影响胜负判定；可见性看 roles.ts 的 inWolfChannel，不看阵营。
   */
  faction: Faction;
  isAlive: boolean;
  /** 死亡天数；存活为 null。要切出局前后得看事件全序的序号，天粒度不够。 */
  deathDay: number | null;
  /** 死因；存活为 null。法官不公布死因，死者自己也看不到它。 */
  deathCause: DeathCause | null;
  /** 解药是否已用掉，一局一次；用掉后不再看到新刀口，见 visibility.ts。 */
  hasAntidoteUsed: boolean;
  /** 毒药是否已用掉。 */
  hasPoisonUsed: boolean;
  /** 守卫上一夜守的目标；空守或还没行动为 null。只记最近一次，不是历史。 */
  guardedOn: string | null;
  /**
   * 预言家已查验过的玩家，查验不能重复。
   * 只读数组：加元素得拼个新数组交给 patchPlayer，就地 push 会毁掉可见性判定要用的历史。
   */
  checkedIds: readonly string[];
}

/** 对局状态。节点执行到一半的中间量（刀口、发言顺序等）不放这儿，归产生它们的规则。 */
export interface GameState {
  gameId: string;
  /** 当前阶段实例身份，见 identity.ts。 */
  phaseInstanceId: PhaseInstanceId;
  /** 当前天数，从 1 起。 */
  day: number;
  phase: Phase;
  players: PlayerState[];
  /** 本局有没有警长环节，建局时定下；为 false 时整段跳过竞选。 */
  hasSheriff: boolean;
  /** 当前警长；警徽被撕、还没选出来、本局没这环节，都是 null。对局已结束时可能指向出局的人。 */
  sheriffId: string | null;
  /**
   * 挂起中的警长竞选：非空时存的是上过警的玩家（第一天报名的那批），
   * 第二天跳过报名与警上发言、直接进退水表态。首轮被狼自爆打断时记上，
   * 续轮再爆就吞掉警徽并清回 null。null 表示竞选没挂起，与「选完了」不分家。
   */
  sheriffElectionSuspended: readonly string[] | null;
}

/** 由建局快照与玩家名单初始化对局状态，玩家 id 按 seats 下标对齐。 */
export function createGameState(setup: GameSetup, playerIds: readonly string[]): GameState {
  if (playerIds.length !== setup.seats.length) {
    throw new Error(
      `玩家名单与座位数不符：名单 ${playerIds.length} 人，座位 ${setup.seats.length} 个`,
    );
  }

  return {
    gameId: setup.gameId,
    phaseInstanceId: phaseInstanceId(0, 'init'),
    day: 1,
    phase: PHASES.NIGHT,
    hasSheriff: setup.hasSheriff,
    sheriffId: null,
    sheriffElectionSuspended: null,
    players: setup.seats.map((seat, index) => ({
      id: playerIds[index],
      seatNo: seat.seatNo,
      role: seat.role,
      faction: factionOf(seat.role),
      isAlive: true,
      deathDay: null,
      deathCause: null,
      hasAntidoteUsed: false,
      hasPoisonUsed: false,
      guardedOn: null,
      checkedIds: [],
    })),
  };
}

/** 场上还活着的人，按座位顺序。 */
export function alivePlayers(state: GameState): PlayerState[] {
  return state.players.filter((player) => player.isAlive);
}

/** 改一名玩家的几个字段，其余原样带过去。 */
export function patchPlayer(
  state: GameState,
  playerId: string,
  patch: Partial<PlayerState>,
): GameState {
  if (!state.players.some((player) => player.id === playerId)) {
    throw new Error(`局内没有 ${playerId}`);
  }

  return {
    ...state,
    players: state.players.map((player) =>
      player.id === playerId ? { ...player, ...patch } : player,
    ),
  };
}
