import type { AskedPrompt } from '../llm/recording-model-port';
import type { CallCompletion, CallRecording } from '../llm/observation';
import type { ExperienceCallInput } from '@werewolf/shared';

/** 落下来的一份提问：问出去的题面，以及它属于哪一次行动。 */
export interface StoredAskedPrompt extends AskedPrompt {
  /** 这一问属于哪次行动，按它跟行动记录对上；折摘要那一问不在行动里，为 null。 */
  actionKey: string | null;
  summaryKey?: string;
}

export interface AskedPromptStore {
  experienceInputs(gameId: string, actionKey: string): Promise<ExperienceCallInput[]>;
  /**
   * 落一份。
   * 每次逻辑调用一行，返回该行的观测写入口；旧题面仍可单独追加。
   */
  append(gameId: string, asked: StoredAskedPrompt): Promise<CallRecording | void>;
  /** 用已持久化的收尾值补完原调用；已收尾的不改，不新增调用。 */
  finishCall(callId: string, result: CallCompletion): Promise<void>;
}
