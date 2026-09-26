import type { GameStatus, ExperienceSnapshot } from '@werewolf/shared';
import type { GameState } from '../core/state';

/**
 * 开局那一刻冻下的一格：谁坐这儿、给他用哪个端点与型号。
 * 端点与型号冻在这儿，中途改了 agent 也换不掉这一局；密钥不冻，用时按 agentId 现读。
 */
export interface RosterSeat {
  seatNo: number;
  agentId: string;
  name: string;
  modelName: string;
  /** 接入端点；null 表示用环境变量那一套。 */
  baseUrl: string | null;
  /** 兼容已有行动使用的旧阵容快照；新行动改为逐次检索。 */
  experiences?: ExperienceSnapshot[];
}

/** 一局对局的档案：这一局是哪块板子、什么时候开的、排到哪儿了、终局胜方。 */
export interface StoredGame {
  gameId: string;
  boardId: string;
  /** 开局定下的阵容；空数组就是整局走环境变量那一套接入。 */
  roster: readonly RosterSeat[];
  /** 终局胜方；null 就是还没分出胜负。 */
  winner: string | null;
  finalState: GameState | null;
  /** 队列上的位置。 */
  status: GameStatus;
  /** 立档那一刻。 */
  createdAt: Date;
}

export interface GameStore {
  /** 这一局的档案；没建过就是 null。 */
  find(gameId: string): Promise<StoredGame | null>;
  /** 立档。同一局已经建过的原样留着：档案记的是开局那一刻，后来的改不了它。 */
  open(game: { gameId: string; boardId: string; roster: readonly RosterSeat[] }): Promise<void>;
  /** 一起保存胜方、终局局面和结束状态。 */
  finish(gameId: string, winner: string, state: GameState): Promise<void>;
  /** 只换状态，不动档案上别的。 */
  setStatus(gameId: string, status: GameStatus): Promise<void>;
  /** 全部档案，新开的在前。 */
  list(): Promise<readonly StoredGame[]>;
}
