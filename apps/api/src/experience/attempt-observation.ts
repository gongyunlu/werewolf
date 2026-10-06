import { ModelCallError } from '../llm/model-port';
import { ModelObservationError, type PendingModelObservation } from '../llm/observation';
import type { AskedPromptStore } from '../store/asked';

export interface AttemptObservation {
  callId: string;
  durationMs?: number;
  observation?: PendingModelObservation;
}

/** 明确未派发或已收到失败结果时才允许新请求，未知传输仍保留原认领。 */
export function attemptFailure(error: unknown) {
  const observation = error instanceof ModelObservationError ? error.pendingAttempt : undefined;
  const completion = error instanceof ModelObservationError ? error.pendingCall : undefined;
  const failed =
    error instanceof ModelCallError ||
    (error instanceof ModelObservationError && !error.dispatched) ||
    (observation !== undefined &&
      observation.result.status !== 'succeeded' &&
      (!observation.result.dispatched || observation.result.failureCode !== 'internal')) ||
    (completion !== undefined &&
      completion.status !== 'accepted' &&
      completion.failureCode !== 'internal');
  return {
    ...(observation ? { observation } : completion ? { observation: { call: completion } } : {}),
    status: failed ? ('failed' as const) : ('pending' as const),
  };
}

/** 先补原请求的用量，再继续解析答复或发起下一次明确失败后的重试。 */
export async function recoverAttemptObservation<T extends AttemptObservation>(
  asked: AskedPromptStore,
  attempt: T,
): Promise<T> {
  if (!attempt.observation) return attempt;
  const { observation, ...rest } = attempt;
  if ('call' in observation) {
    await asked.finishCall(attempt.callId, observation.call);
    return rest as T;
  }
  await asked.finishAttempt(attempt.callId, observation.attemptNo, observation.result);
  if (observation.result.status !== 'succeeded')
    await asked.finishCall(attempt.callId, {
      status: observation.result.status,
      failureCode: observation.result.failureCode,
      durationMs: attempt.durationMs ?? observation.result.durationMs,
    });
  return rest as T;
}
