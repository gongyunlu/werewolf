/** 一局对局的档案：这一局是哪块板子、终局胜方。 */
export interface StoredGame {
  gameId: string;
  boardId: string;
  /** 终局胜方；null 就是还没分出胜负。 */
  winner: string | null;
}

export interface GameStore {
  /** 这一局的档案；没建过就是 null。 */
  find(gameId: string): Promise<StoredGame | null>;
  /** 立档。同一局已经建过的原样留着：档案记的是开局那一刻，后来的改不了它。 */
  open(game: Omit<StoredGame, 'winner'>): Promise<void>;
  /** 记下终局胜方。 */
  finish(gameId: string, winner: string): Promise<void>;
}
