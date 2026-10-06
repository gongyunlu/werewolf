import type { AskedPrompt } from '../llm/recording-model-port';
import type { AttemptCompletion, CallCompletion, CallRecording } from '../llm/observation';
import type { ExperienceCallInput, KnowledgeCallInput, KnowledgeCalls } from '@werewolf/shared';
import { ModelRecoveryError } from '../llm/observation';
import type { AttemptRow, CallRow } from './observations';

/** 落下来的一份提问：问出去的题面，以及它属于哪一次行动。 */
export interface StoredAskedPrompt extends AskedPrompt {
  knowledgeVersionId?: string;
  knowledgeCaptureId?: string;
  /** 这一问属于哪次行动，按它跟行动记录对上；折摘要那一问不在行动里，为 null。 */
  actionKey: string | null;
  summaryKey?: string;
}

export interface AskedPromptStore {
  knowledgeInputs(gameId: string, actionKey: string): Promise<KnowledgeCallInput[]>;
  knowledgeCalls(versionId: string): Promise<KnowledgeCalls>;
  captureCalls(captureId: string): Promise<KnowledgeCalls>;
  experienceInputs(gameId: string, actionKey: string): Promise<ExperienceCallInput[]>;
  /**
   * 落一份。
   * 每次逻辑调用一行，返回该行的观测写入口；旧题面仍可单独追加。
   * 原生任务恢复必须先复用答复；同一步已有未确认或已接受的调用时，拒绝另起一问。
   */
  append(gameId: string | null, asked: StoredAskedPrompt): Promise<CallRecording | void>;
  /** 用已持久化的收尾值补完原调用；已收尾的不改，不新增调用。 */
  finishCall(callId: string, result: CallCompletion): Promise<void>;
  /** 补写已保存的请求结果和用量，不创建新请求。 */
  finishAttempt(callId: string, attemptNo: number, result: AttemptCompletion): Promise<void>;
}

export function assertAskedScope(
  gameId: string | null,
  knowledgeVersionId?: string,
  knowledgeCaptureId?: string,
): void {
  if (
    [gameId !== null, knowledgeVersionId !== undefined, knowledgeCaptureId !== undefined].filter(
      Boolean,
    ).length !== 1
  )
    throw new Error('调用必须且只能归属对局、独立知识版本或采集整理任务');
}

/** 只按最后一次请求的明确失败补收尾，耗时缺失就保持缺失。 */
export function interruptedCallFailure(
  call: Pick<CallRow, 'callId' | 'status' | 'failureCode'>,
  attempt?: Pick<AttemptRow, 'status' | 'dispatched' | 'failureCode' | 'finishedAt'>,
): Pick<CallRow, 'status' | 'failureCode' | 'finishedAt'> | null {
  const failed =
    attempt &&
    (attempt.status === 'failed' || attempt.status === 'cancelled') &&
    (attempt.dispatched === false ||
      (attempt.failureCode !== null && attempt.failureCode !== 'internal'));
  if (call.status === 'started' && failed)
    return {
      status: attempt.status,
      failureCode: attempt.failureCode,
      finishedAt: attempt.finishedAt,
    };
  if (
    call.status === 'started' ||
    call.status === 'accepted' ||
    (call.status === 'failed' && call.failureCode === 'internal' && attempt && !failed)
  )
    throw new ModelRecoveryError(call.callId!);
  return null;
}
