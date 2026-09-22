import type { AskedPrompt } from '../llm/recording-model-port';

/** 落下来的一份提问：问出去的题面，以及它属于哪一次行动。 */
export interface StoredAskedPrompt extends AskedPrompt {
  /** 这一问属于哪次行动，按它跟行动记录对上；折摘要那一问不在行动里，为 null。 */
  actionKey: string | null;
}

export interface AskedPromptStore {
  /**
   * 落一份。
   * 这张表不认重、也不盖旧的：同一问重问几遍就留几行，要看的正是它问了几遍、每一遍附了什么。
   */
  append(gameId: string, asked: StoredAskedPrompt): Promise<void>;
}
