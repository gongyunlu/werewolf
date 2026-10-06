import { randomUUID } from 'node:crypto';
import { embeddingKey, validVector, type EmbeddingRuntime } from '../llm/embedding';
import type { ModelResponse } from '../llm/model-port';
import type { PendingModelObservation } from '../llm/observation';
import { recordingModelPort } from '../llm/recording-model-port';
import type { GameStores } from '../store/stores';
import { attemptFailure, recoverAttemptObservation } from './attempt-observation';

export interface EmbeddingTask {
  text: string;
  key: string;
  model: string;
  dimensions: number;
  textVersion?: string;
  attempts: Array<{
    callId: string;
    status: 'pending' | 'responded' | 'failed';
    vector?: number[];
    durationMs?: number;
    observation?: PendingModelObservation;
  }>;
}

export function newEmbeddingTask(
  text: string,
  runtime: EmbeddingRuntime,
  textVersion?: string,
): EmbeddingTask {
  return {
    text,
    key: embeddingKey(runtime, textVersion),
    model: runtime.access.model,
    dimensions: runtime.dimensions,
    ...(textVersion ? { textVersion } : {}),
    attempts: [],
  };
}

/** 先保存向量答复，再结束观测；后续写库失败只恢复答复，不重新调用。 */
export async function embedTask(
  stores: GameStores,
  scope: {
    gameId: string | null;
    actionKey: string | null;
    summaryKey?: string;
    knowledgeVersionId?: string;
  },
  initial: EmbeddingTask,
  runtime: EmbeddingRuntime,
  save: (task: EmbeddingTask) => Promise<void>,
): Promise<number[]> {
  let task = initial;
  const persist = async (next: EmbeddingTask) => {
    await save(next);
    task = next;
  };
  let attempt = task.attempts.at(-1);
  if (attempt?.observation) {
    attempt = await recoverAttemptObservation(stores.asked, attempt);
    await persist({ ...task, attempts: [...task.attempts.slice(0, -1), attempt] });
  }
  if (attempt?.status === 'pending')
    throw new Error('上次向量请求结果未知，已停止自动重发，请核查调用记录');
  let finish: ModelResponse['completeObservation'];
  if (!attempt || attempt.status === 'failed') {
    if (task.key !== embeddingKey(runtime, task.textVersion))
      throw new Error('向量接入或型号已改变，不能在同一任务中混用');
    attempt = { callId: randomUUID(), status: 'pending' };
    await persist({ ...task, attempts: [...task.attempts, attempt] });
    const port = recordingModelPort(
      runtime.port,
      (asked) => stores.asked.append(scope.gameId, { ...asked, ...scope }),
      scope,
    );
    let received: ModelResponse | undefined;
    let failure: unknown;
    const started = performance.now();
    try {
      const response = await port.generate(
        {
          system: '参考材料语义向量化',
          prompt: task.text,
          embedding: { dimensions: task.dimensions },
        },
        runtime.access,
        {
          identity: {
            callId: attempt.callId,
            executionId: randomUUID(),
            step: scope.knowledgeVersionId ? 'knowledge_embedding' : 'experience_embedding',
            formatAttempt: 1,
          },
          onResponse: (value) => {
            received = value;
          },
        },
      );
      received = response;
      finish = response.completeObservation;
    } catch (error) {
      failure = error;
      if (!received) {
        await persist({
          ...task,
          attempts: [...task.attempts.slice(0, -1), { ...attempt, ...attemptFailure(error) }],
        });
        throw error;
      }
    }
    attempt = {
      ...attempt,
      ...attemptFailure(failure),
      status: 'responded',
      durationMs: performance.now() - started,
      ...(received.vector ? { vector: received.vector } : {}),
    };
    await persist({ ...task, attempts: [...task.attempts.slice(0, -1), attempt] });
    if (failure) throw failure;
  }
  try {
    validVector(attempt.vector, task.dimensions);
  } catch (error) {
    await stores.asked.finishCall(attempt.callId, {
      status: 'invalid_output',
      failureCode: 'invalid_output',
      durationMs: attempt.durationMs ?? 0,
    });
    await persist({
      ...task,
      attempts: [...task.attempts.slice(0, -1), { ...attempt, status: 'failed' }],
    });
    throw error;
  }
  if (finish) await finish('accepted');
  else
    await stores.asked.finishCall(attempt.callId, {
      status: 'accepted',
      failureCode: null,
      durationMs: attempt.durationMs ?? 0,
    });
  return attempt.vector;
}
