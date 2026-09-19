import type { DeathCause } from '@werewolf/shared';
import type { GameState } from '../state';

/** 今晨要公布的一名死者。死因由夜间结算给出。 */
export interface NightDeath {
  playerId: string;
  cause: DeathCause;
}

/**
 * 公布出去的死讯：谁出局、坐几号。
 * 不带死因，死因只留在 PlayerState.deathCause，口径见 visibility.ts。
 */
export interface DeathAnnouncement {
  playerId: string;
  seatNo: number;
}

/** 天亮时的公布结果。deaths 为空就是平安夜。 */
export interface AnnounceResult {
  /** 把死亡落到玩家身上之后的状态。 */
  state: GameState;
  /** 公布出去的死讯，按座位号升序。 */
  deaths: DeathAnnouncement[];
}

/**
 * 天亮公布死讯：把今晨的死者落到状态上，并给出对外公布的内容。
 * 白天不会再有人死，所以死亡天数就是当前天数。
 */
export function announceDay(state: GameState, deaths: readonly NightDeath[]): AnnounceResult {
  const playerById = new Map(state.players.map((player) => [player.id, player]));
  const causeById = new Map<string, DeathCause>();

  for (const death of deaths) {
    const player = playerById.get(death.playerId);
    if (!player) throw new Error(`死讯里的玩家不在局内：${death.playerId}`);
    if (!player.isAlive) throw new Error(`已经出局的人不会再公布一次死讯：${death.playerId}`);
    if (causeById.has(death.playerId))
      throw new Error(`死讯里重复出现同一名玩家：${death.playerId}`);
    causeById.set(death.playerId, death.cause);
  }

  return {
    state: {
      ...state,
      players: state.players.map((player) => {
        const cause = causeById.get(player.id);
        return cause === undefined
          ? player
          : { ...player, isAlive: false, deathDay: state.day, deathCause: cause };
      }),
    },
    deaths: state.players
      .flatMap((player) =>
        causeById.has(player.id) ? [{ playerId: player.id, seatNo: player.seatNo }] : [],
      )
      .toSorted((a, b) => a.seatNo - b.seatNo),
  };
}
