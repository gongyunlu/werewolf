import { tokenUsage, usageIssues, type TokenUsage } from '../llm/observation';
import type { CallRow, ObservationData } from '../store/observations';

export interface KnownMetric {
  knownSum: number | null;
  knownCount: number;
  missingCount: number;
  partialCount: number;
}

function metric(values: { value: number | null; complete: boolean }[]): KnownMetric {
  let knownSum: number | null = null;
  let knownCount = 0;
  let missingCount = 0;
  let partialCount = 0;
  for (const { value, complete } of values) {
    if (value === null) missingCount++;
    else if (!complete) partialCount++;
    else {
      knownSum = (knownSum ?? 0) + value;
      knownCount++;
    }
  }
  return { knownSum, knownCount, missingCount, partialCount };
}

export function costOf(rows: CallRow[]) {
  const calls = rows.filter((row) => row.callId !== null);
  const attempts = calls.flatMap((row) => row.attempts);
  const sent = attempts.filter((row) => row.dispatched === true);
  // 发前取消没有 token；是否发出未知的尝试仍需要计入用量缺失覆盖率。
  const usage = attempts
    .filter((row) => row.dispatched !== false)
    .map((row) => ({
      value: tokenUsage(row.usage),
      complete: row.usageComplete === true,
    }));
  const tokens = Object.fromEntries(
    (['input', 'output', 'total', 'cacheRead', 'cacheWrite', 'reasoning'] as const).map((key) => [
      key,
      metric(usage.map((row) => ({ value: row.value[key], complete: row.complete }))),
    ]),
  ) as Record<keyof TokenUsage, KnownMetric>;
  const requestDurationMs = metric(
    attempts
      .filter((row) => row.dispatched !== false)
      .map((row) => ({ value: row.durationMs, complete: row.finishedAt !== null })),
  );
  return {
    coverage:
      rows.length === 0
        ? 'unknown'
        : rows.some((row) => row.callId === null)
          ? calls.length === 0
            ? 'legacy'
            : 'partial'
          : calls.some((row) => row.status === 'started') ||
              attempts.some((row) => row.dispatched === null)
            ? 'partial'
            : 'complete',
    legacyPrompts: rows.length - calls.length,
    logicalCalls: calls.length,
    modelNodeExecutions: new Set(calls.flatMap((row) => (row.executionId ? [row.executionId] : [])))
      .size,
    accepted: calls.filter((row) => row.status === 'accepted').length,
    invalidOutput: calls.filter((row) => row.status === 'invalid_output').length,
    failed: calls.filter((row) => row.status === 'failed').length,
    cancelled: calls.filter((row) => row.status === 'cancelled').length,
    unfinished: calls.filter((row) => row.status === 'started').length,
    formatRetries: calls.filter((row) => (row.formatAttempt ?? 0) > 1).length,
    requests: {
      dispatched: sent.length,
      succeeded: sent.filter((row) => row.status === 'succeeded').length,
      failed: sent.filter((row) => row.status === 'failed').length,
      cancelled: sent.filter((row) => row.status === 'cancelled').length,
      notDispatched: attempts.filter((row) => row.dispatched === false).length,
      unknown: attempts.filter((row) => row.dispatched === null).length,
      retries: sent.filter((row) => row.attemptNo > 1).length,
    },
    logicalDurationMs: metric(
      calls.map((row) => ({ value: row.durationMs, complete: row.finishedAt !== null })),
    ),
    requestDurationMs,
    averageRequestDurationMs:
      requestDurationMs.knownSum === null
        ? null
        : requestDurationMs.knownSum / requestDurationMs.knownCount,
    tokens,
  };
}

function grouped(rows: CallRow[], keyOf: (row: CallRow) => string) {
  const groups = new Map<string, CallRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const items = groups.get(key) ?? [];
    items.push(row);
    groups.set(key, items);
  }
  return [...groups].map(([key, items]) => ({ key, ...costOf(items) }));
}

export function gameStatistics(
  data: ObservationData,
  query: { actionKey?: string; summaryKey?: string; after?: number; limit: number },
) {
  const byAction = new Map(data.actions.map((row) => [row.actionKey, row]));
  const selected = data.calls.filter(
    (row) =>
      (!query.actionKey || row.actionKey === query.actionKey) &&
      (!query.summaryKey || row.summaryKey === query.summaryKey),
  );
  const page = selected.filter((row) => row.id > (query.after ?? 0)).slice(0, query.limit + 1);
  const hasMore = page.length > query.limit;
  const items = page.slice(0, query.limit);
  return {
    game: data.game,
    total: costOf(data.calls),
    publicOverhead: costOf(data.calls.filter((row) => row.summaryKey !== null)),
    reviewOverhead: costOf(data.calls.filter((row) => row.step?.startsWith('review_'))),
    unattributed: costOf(
      data.calls.filter(
        (row) =>
          row.actionKey === null && row.summaryKey === null && !row.step?.startsWith('review_'),
      ),
    ),
    players: grouped(
      data.calls.filter((row) => row.actionKey !== null),
      (row) => byAction.get(row.actionKey!)?.actorId ?? 'unknown',
    ),
    models: grouped(data.calls, (row) => `${row.endpointKey ?? 'unknown'}/${row.model}`),
    steps: grouped(data.calls, (row) => row.step ?? 'unknown'),
    actionTypes: grouped(
      data.calls.filter((row) => row.actionKey !== null),
      (row) => byAction.get(row.actionKey!)?.actionType ?? 'unknown',
    ),
    actions: data.actions,
    selected: costOf(selected),
    calls: items.map((row) => ({
      ...row,
      adopted:
        row.callId === null || row.actionKey === null || !byAction.get(row.actionKey)?.sourceCallId
          ? null
          : byAction.get(row.actionKey)?.sourceCallId === row.callId,
      attempts: row.attempts.map(({ usage, ...attempt }) => ({
        ...attempt,
        tokens: tokenUsage(usage),
        usageIssues: usageIssues(usage),
      })),
    })),
    nextCursor: hasMore ? items.at(-1)!.id : null,
  };
}
