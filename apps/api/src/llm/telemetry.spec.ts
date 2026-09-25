import type { SpanContext } from '@opentelemetry/api';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../config/env';
import { memoryStores } from '../store/memory';
import { openaiModelPort } from './openai-model-port';
import { recordingModelPort } from './recording-model-port';
import { retryingModelPort } from './retrying-model-port';
import { callSpan, promptAttributes, startTelemetry, stopTelemetry } from './telemetry';

interface CapturedSpan {
  name: string;
  attributes: Record<string, unknown>;
  parentSpanContext?: SpanContext;
  spanContext(): SpanContext;
}
const mockSpans: CapturedSpan[] = [];
jest.mock('@langfuse/otel', () => ({
  LangfuseSpanProcessor: jest.fn().mockImplementation(() => ({
    onStart() {},
    onEnd(span: CapturedSpan) {
      mockSpans.push(span);
    },
    async forceFlush() {},
    shutdown: jest.fn(async () => {}),
  })),
}));

describe('遥测只记录真实请求', () => {
  beforeEach(() => jest.mocked(LangfuseSpanProcessor).mockClear());
  afterAll(stopTelemetry);

  it('导出器初始化失败只禁用遥测，不阻断应用启动', () => {
    jest.mocked(LangfuseSpanProcessor).mockImplementationOnce(() => {
      throw new Error('无法初始化导出器');
    });
    expect(() =>
      startTelemetry({
        ...loadEnv(),
        LANGFUSE_PUBLIC_KEY: 'pk-test',
        LANGFUSE_SECRET_KEY: 'sk-test',
      }),
    ).not.toThrow();
    expect(callSpan('g', {})).toBeUndefined();
  });

  it('初始化幂等、并发隔离；预取消没有 generation，关闭等待 SDK flush', async () => {
    const env = { ...loadEnv(), LANGFUSE_PUBLIC_KEY: 'pk-test', LANGFUSE_SECRET_KEY: 'sk-test' };
    startTelemetry(env);
    startTelemetry(env);
    expect(LangfuseSpanProcessor).toHaveBeenCalledTimes(1);
    const stores = memoryStores();
    const run = async (gameId: string, aborted: boolean) => {
      await stores.games.open({ gameId, boardId: 'test', roster: [] });
      const fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: 'stop', message: { content: 'private-answer' } }],
              usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      );
      const port = recordingModelPort(
        retryingModelPort(openaiModelPort({ fetch }), { backoffMs: 0 }),
        (asked) => stores.asked.append(gameId, { ...asked, actionKey: 'a' }),
        { gameId, actionKey: 'a' },
      );
      const pending = port.generate(
        {
          system: 'private-system',
          prompt: 'private-prompt',
          prompts: [
            { name: 'turn/generate-system', version: 3, source: 'platform' },
            { name: 'turn/generate-user', version: 8, source: 'platform' },
          ],
        },
        {
          baseUrl: 'http://offline.invalid',
          model: 'test',
          apiKey: 'private-api-key',
          capability: { reasoningOff: null },
        },
        {
          identity: {
            callId: randomUUID(),
            executionId: randomUUID(),
            step: 'generate',
            formatAttempt: 1,
          },
          ...(aborted ? { signal: AbortSignal.abort() } : {}),
        },
      );
      if (aborted) await expect(pending).rejects.toThrow();
      else await (await pending).completeObservation?.('accepted');
      return (await stores.observations.read(gameId))!.calls[0];
    };
    const rows = await Promise.all([run('a', false), run('b', false), run('c', true)]);
    expect(new Set(rows.map((row) => row.traceId)).size).toBe(3);
    expect(mockSpans.filter((span) => span.name === 'model.call')).toHaveLength(3);
    const generations = mockSpans.filter((span) => span.name === 'model.request');
    expect(generations).toHaveLength(2);
    for (const row of rows.slice(0, 2)) {
      const span = generations.find(
        (item) => item.spanContext().spanId === row.attempts[0].spanId,
      )!;
      expect(span.spanContext().traceId).toBe(row.traceId);
      expect(span.parentSpanContext?.spanId).toBe(row.spanId);
      expect(JSON.stringify(span.attributes)).toContain(row.callId!);
      expect(JSON.stringify(span.attributes)).toContain(row.gameId);
      expect(span.attributes['langfuse.observation.prompt.name']).toBe('turn/generate-system');
      expect(span.attributes['langfuse.observation.prompt.version']).toBe(3);
      expect(JSON.stringify(span.attributes)).toContain('turn/generate-user');
      expect(JSON.stringify(span.attributes)).toContain('8');
    }
    expect(rows[2].attempts[0].spanId).toBeNull();
    expect(JSON.stringify(mockSpans.map((span) => span.attributes))).not.toMatch(
      /private-system|private-prompt|private-answer|private-api-key|offline.invalid/,
    );
    const processor = jest.mocked(LangfuseSpanProcessor).mock.results[0].value;
    processor.onEnd = () => {
      throw new Error('遥测故障');
    };
    const local = await run('d', false);
    expect(local.status).toBe('accepted');
    expect(local.attempts).toHaveLength(1);
    expect(local.attempts[0].status).toBe('succeeded');
    await stopTelemetry();
    expect(processor.shutdown).toHaveBeenCalledTimes(1);
  });
});

it('单次关联可选 user，完整清单保留；本地正文不冒充平台版本', () => {
  const prompts = [
    { name: 'system', version: null, source: 'local' as const },
    { name: 'user', version: 5, source: 'platform' as const },
  ];
  expect(promptAttributes({ prompts }).prompt).toBeUndefined();
  expect(promptAttributes({ prompts, primaryPrompt: 'user' })).toEqual({
    prompt: { name: 'user', version: 5, isFallback: false },
    metadata: { prompts },
  });
});
