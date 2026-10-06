import { task } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import { attemptFailure, recoverAttemptObservation } from '../experience/attempt-observation';
import type { ModelResponse } from '../llm/model-port';
import { ModelObservationError, type PendingModelObservation } from '../llm/observation';
import type { AskedPromptStore } from '../store/asked';

interface SavedCall {
  callId: string;
  durationMs: number;
  response?: Omit<ModelResponse, 'completeObservation'>;
  observation?: PendingModelObservation;
  status?: 'failed' | 'pending';
}

/** 耗尽格式重问先报错；只有人工续跑重放到这条记录时，才开始新一轮。 */
export async function resumeFormatBudget(): Promise<boolean> {
  let replayed = true;
  await task('model.format-exhausted', () => {
    replayed = false;
    return null;
  })();
  return replayed;
}

/** 每次答复先存入原生任务检查点，观测补写失败时只恢复记录，不重新采样。 */
export async function checkpointedCall(
  asked: AskedPromptStore,
  invoke: (callId: string, onResponse: (response: ModelResponse) => void) => Promise<ModelResponse>,
  onResponse?: (response: ModelResponse, callId: string) => void,
): Promise<ModelResponse & { callId: string }> {
  for (;;) {
    let failure: ModelObservationError | undefined;
    let complete: ModelResponse['completeObservation'];
    let executed = false;
    const saved = await task('model.response', async (): Promise<SavedCall> => {
      executed = true;
      const callId = randomUUID();
      const started = performance.now();
      let received: ModelResponse | undefined;
      let recovery: Pick<SavedCall, 'status' | 'observation'> | undefined;
      try {
        const response = await invoke(callId, (value) => {
          received = value;
          onResponse?.(value, callId);
        });
        received = response;
        complete = response.completeObservation;
      } catch (error) {
        if (!(error instanceof ModelObservationError)) throw error;
        recovery = attemptFailure(error);
        if (!recovery.observation) throw error;
        failure = error;
      }
      return {
        callId,
        durationMs: performance.now() - started,
        ...recovery,
        ...(received
          ? {
              response: {
                content: received.content,
                toolCall: received.toolCall,
                reasoning: received.reasoning,
                ...(received.thinkingMs !== undefined ? { thinkingMs: received.thinkingMs } : {}),
              },
            }
          : {}),
      };
    })();
    // 先让任务结果落盘，再向调用方报告本次存储错误。
    if (failure) throw failure;
    await recoverAttemptObservation(asked, saved);
    if (!saved.response) {
      if (saved.status === 'failed') continue;
      throw new Error('上次模型请求结果未知，请核查调用记录后恢复');
    }
    if (!executed) onResponse?.(saved.response, saved.callId);
    return {
      ...saved.response,
      callId: saved.callId,
      completeObservation: async (status, beforeWrite) => {
        if (complete) return complete(status, beforeWrite);
        const result = {
          status,
          failureCode: status === 'accepted' ? null : status === 'failed' ? 'internal' : status,
          durationMs: saved.durationMs,
        };
        beforeWrite?.(result);
        await asked.finishCall(saved.callId, result);
      },
    };
  }
}
