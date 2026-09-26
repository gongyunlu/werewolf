import type { AttemptCompletion, CallCompletion, CallIdentity } from '../llm/observation';

export interface AttemptRow extends Omit<
  AttemptCompletion,
  'status' | 'dispatched' | 'durationMs' | 'usageComplete' | 'traceId' | 'spanId'
> {
  attemptNo: number;
  status: string;
  dispatched: boolean | null;
  durationMs: number | null;
  usageComplete: boolean | null;
  startedAt: Date;
  finishedAt: Date | null;
  traceId: string | null;
  spanId: string | null;
}

export interface CallRow {
  id: number;
  gameId: string | null;
  knowledgeVersionId?: string;
  actionKey: string | null;
  summaryKey: string | null;
  model: string;
  callId: string | null;
  executionId: string | null;
  step: string | null;
  formatAttempt: number | null;
  taskId: string | null;
  checkpointId: string | null;
  endpointKey: string | null;
  status: string | null;
  failureCode: string | null;
  durationMs: number | null;
  createdAt: Date;
  finishedAt: Date | null;
  traceId: string | null;
  spanId: string | null;
  attempts: AttemptRow[];
}

export interface ObservationData {
  game: { gameId: string; status: string; winner: string | null };
  actions: {
    actionKey: string;
    actorId: string;
    actionType: string;
    status: string;
    sourceCallId: string | null;
  }[];
  calls: CallRow[];
}

export interface ObservationStore {
  /** 同一读快照内取元数据，不加载题面、完整结果或检查点。 */
  read(gameId: string): Promise<ObservationData | null>;
}

export function newCallRow(
  id: number,
  gameId: string | null,
  model: string,
  actionKey: string | null,
  summaryKey: string | undefined,
  identity?: CallIdentity & { endpointKey: string; traceId?: string; spanId?: string },
): CallRow {
  return {
    id,
    gameId,
    model,
    actionKey,
    summaryKey: summaryKey ?? null,
    callId: null,
    executionId: null,
    step: null,
    formatAttempt: null,
    endpointKey: null,
    ...identity,
    taskId: identity?.taskId ?? null,
    checkpointId: identity?.checkpointId ?? null,
    status: identity ? 'started' : null,
    failureCode: null,
    durationMs: null,
    createdAt: new Date(),
    finishedAt: null,
    traceId: identity?.traceId ?? null,
    spanId: identity?.spanId ?? null,
    attempts: [],
  };
}

export function newAttemptRow(attemptNo: number): AttemptRow {
  return {
    attemptNo,
    status: 'started',
    dispatched: null,
    durationMs: null,
    usageComplete: null,
    failureCode: null,
    thinkingMs: null,
    httpStatus: null,
    requestId: null,
    usage: null,
    startedAt: new Date(),
    finishedAt: null,
    traceId: null,
    spanId: null,
  };
}

export function finishCallRow(row: CallRow, result: CallCompletion): void {
  Object.assign(row, result, { finishedAt: new Date() });
}
