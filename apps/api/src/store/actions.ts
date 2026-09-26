import type { ActionType } from '@werewolf/shared';
import { z } from 'zod';
import type { ExperienceRetrieval } from '@werewolf/shared';
import type { EmbeddingTask } from '../experience/embedding-task';
import type { ExperienceScope } from './experiences';

export type StoredExperienceRetrieval = ExperienceRetrieval & {
  scope: ExperienceScope;
  embedding?: EmbeddingTask;
};

/** 列表读取的快照字段；旧记录可以没有思考或耗时。 */
export const ActionSnapshotFields = z.object({
  context: z.object({
    task: z.string(),
    actor: z.object({ seatNo: z.number(), role: z.string() }),
    day: z.number(),
  }),
  decision: z.unknown(),
  reasoning: z.string().nullable().default(null),
  thinkingMs: z.number().nullable().optional(),
});

/** outcome 只含列表所需字段，不含可见历史、提示词和思考正文。 */
export interface StoredActionSummary extends StoredAction {
  hasReasoning: boolean;
}

/** 一次提问立下的意图：问的是谁、问的什么、问的时候台账到哪儿。 */
export interface ActionIntent {
  experienceRetrieval?: StoredExperienceRetrieval | null;
  actionKey: string;
  gameId: string;
  phaseInstanceId: string;
  actionType: ActionType;
  actorId: string;
  actionOrdinal: number;
  /**
   * 立这一问时台账记到第几条。
   * 断了再起时台账是整份铺回来的，比那一刻长出好几条；要取回的是这一问当初看到的那一份，
   * 而那是个位置不是某条事实，所以记位置。
   */
  ledgerSeq: number;
}

/** 提交记录：意图先立，答完再补结果。 */
export interface StoredAction extends ActionIntent {
  /** running 是这次还没答完，重走到这一问会重新跑一遍；done 才是结果。 */
  status: 'running' | 'done';
  /** 答完才有：这次行动交出去的东西，即决定与它的来历。 */
  outcome: unknown;
}

export interface ActionStore {
  /** 取回这一次提问的记录；没立过就是 null。 */
  find(actionKey: string): Promise<StoredAction | null>;
  /** 取回这一局的全部记录，按问的先后排；没立过就是空数组。没答完的那几行也在里头。 */
  list(gameId: string): Promise<StoredAction[]>;
  summaries(gameId: string): Promise<StoredActionSummary[]>;
  /** 立意图。已经立过的不再写，先立那份原样留着。 */
  begin(intent: ActionIntent): Promise<void>;
  saveRetrieval(
    actionKey: string,
    previous: StoredExperienceRetrieval,
    next: StoredExperienceRetrieval,
  ): Promise<void>;
  /** 答完，补上结果。 */
  finish(actionKey: string, outcome: unknown): Promise<void>;
}
