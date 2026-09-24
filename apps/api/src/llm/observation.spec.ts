import { randomUUID } from 'node:crypto';
import { ModelCallError, type ModelAccess } from './model-port';
import { openaiModelPort, type SendRequest } from './openai-model-port';
import { recordingModelPort } from './recording-model-port';
import { retryingModelPort } from './retrying-model-port';
import { tokenUsage } from './observation';
import { memoryStores } from '../store/memory';
import { ask, askParsed, parseStructured } from '../turn/graph';
import { costOf } from '../games/statistics';
import { z } from 'zod';

const ACCESS: ModelAccess = {
  model: 'test',
  baseUrl: 'http://model.test/v1',
  apiKey: 'secret',
  capability: { reasoningOff: null, streamUsage: true },
};
const REQUEST = { system: '不能外传的题面', prompt: '正文' };
const TOOL = { name: 'submit', description: '提交', parameters: { type: 'object' } };
const identity = () => ({
  callId: randomUUID(),
  executionId: randomUUID(),
  step: 'generate',
  formatAttempt: 1,
});
const json = (value: unknown, usage?: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [{ function: { name: 'submit', arguments: JSON.stringify(value) } }],
          },
        },
      ],
      usage,
    }),
    { headers: { 'content-type': 'application/json', 'x-request-id': 'provider-request' } },
  );
const stream = (...chunks: unknown[]) =>
  new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );

async function setup(fetch: SendRequest) {
  const stores = memoryStores();
  await stores.games.open({ gameId: 'g', boardId: 'test', roster: [] });
  const port = recordingModelPort(
    retryingModelPort(openaiModelPort({ fetch }), { backoffMs: 0 }),
    (asked) => stores.asked.append('g', { ...asked, actionKey: 'a' }),
  );
  const rows = async () => (await stores.observations.read('g'))!.calls;
  return { stores, port, rows };
}

describe('模型开销记录', () => {
  it('缺失、显式零与供应商细分保持区别，不补 total、不把缓存未命中当写入', () => {
    expect(tokenUsage(null)).toEqual({
      input: null,
      output: null,
      total: null,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
    });
    expect(
      tokenUsage({
        prompt_tokens: 10,
        completion_tokens: 0,
        prompt_cache_hit_tokens: 4,
        prompt_cache_miss_tokens: 6,
      }),
    ).toEqual({
      input: 10,
      output: 0,
      total: null,
      cacheRead: 4,
      cacheWrite: null,
      reasoning: null,
    });
  });

  it('503 重试只留一份题面；格式重问另开调用，所有尝试开销保留', async () => {
    let sent = 0;
    const { port, rows } = await setup(async () => {
      sent++;
      if (sent === 1) return new Response('busy', { status: 503 });
      return json(
        { value: sent === 2 ? '错值' : 2 },
        { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      );
    });
    const executionId = randomUUID();
    const answer = await askParsed(
      (note, formatAttempt) =>
        ask(
          port,
          ACCESS,
          {
            system: {
              template: 'turn/generate-system',
              source: 'local',
              version: null,
              text: REQUEST.system,
            },
            user: {
              template: 'turn/generate-user',
              source: 'local',
              version: null,
              text: note ?? REQUEST.prompt,
            },
          },
          TOOL,
          undefined,
          { executionId, step: 'generate', formatAttempt },
        ),
      (content) => parseStructured(content, z.number(), '结果'),
      () => '请重问',
    );
    const calls = await rows();
    expect(sent).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls.map((row) => row.status)).toEqual(['invalid_output', 'accepted']);
    expect(calls.map((row) => row.attempts.length)).toEqual([2, 1]);
    expect(calls[0].executionId).toBe(calls[1].executionId);
    expect(calls[0].callId).not.toBe(calls[1].callId);
    expect(answer.callId).toBe(calls[1].callId);
    expect(costOf(calls)).toMatchObject({
      logicalCalls: 2,
      formatRetries: 1,
      requests: { dispatched: 3, succeeded: 2, failed: 1, retries: 1 },
      tokens: { total: { knownSum: 24, missingCount: 1, knownCount: 2 } },
    });
    expect(calls[0].attempts[0].httpStatus).toBe(503);
    expect(calls[1].attempts[0].requestId).toBe('provider-request');
    expect(calls[1].attempts[0].thinkingMs).toBeNull();
  });

  it('usage-only 片不会漏，累计用量只取最后一份，显式零保持零', async () => {
    let params: Record<string, unknown> = {};
    const { port, rows } = await setup(async (_url, init) => {
      params = JSON.parse(init!.body as string) as Record<string, unknown>;
      return stream(
        {
          choices: [{ delta: { content: '答案' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20 },
        },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } },
      );
    });
    const result = await port.generate(REQUEST, ACCESS, {
      identity: identity(),
      onDelta: () => {},
    });
    await result.completeObservation?.('accepted');
    expect(params.stream_options).toEqual({ include_usage: true });
    const calls = await rows();
    expect(calls[0].attempts[0].usageComplete).toBe(true);
    expect(costOf(calls).tokens.output.knownSum).toBe(0);
    expect(costOf(calls).tokens.input.knownSum).toBe(10);
  });

  it('中途累计用量之后仍有输出，末尾没有新用量时只记为部分', async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
    const { port, rows } = await setup(async () =>
      stream(
        { choices: [{ delta: { content: '前半' } }], usage },
        { choices: [{ delta: { content: '后半' }, finish_reason: 'stop' }] },
      ),
    );
    const response = await port.generate(REQUEST, ACCESS, {
      identity: identity(),
      onDelta: () => {},
    });
    await response.completeObservation?.('accepted');
    const calls = await rows();
    expect(calls[0].attempts[0]).toMatchObject({ usage, usageComplete: false });
    expect(costOf(calls).tokens.total).toEqual({
      knownSum: null,
      knownCount: 0,
      missingCount: 0,
      partialCount: 1,
    });
  });

  it('结束分片自带的用量仍计入完整小计', async () => {
    const { port, rows } = await setup(async () =>
      stream({
        choices: [{ delta: { content: '答案' }, finish_reason: 'stop' }],
        usage: { total_tokens: 11 },
      }),
    );
    const response = await port.generate(REQUEST, ACCESS, {
      identity: identity(),
      onDelta: () => {},
    });
    await response.completeObservation?.('accepted');
    expect(costOf(await rows()).tokens.total).toEqual({
      knownSum: 11,
      knownCount: 1,
      missingCount: 0,
      partialCount: 0,
    });
  });

  it('流未正常结束，已有 usage 标为部分，不混入完整小计', async () => {
    const { port, rows } = await setup(async () =>
      stream({ choices: [{ delta: { content: '半截' } }], usage: { prompt_tokens: 4 } }),
    );
    await expect(
      port.generate(REQUEST, ACCESS, { identity: identity(), onDelta: () => {} }),
    ).rejects.toThrow('缺少结束原因');
    const calls = await rows();
    expect(calls[0].attempts).toHaveLength(1);
    expect(calls[0].attempts[0].usage).toEqual({ prompt_tokens: 4 });
    expect(costOf(calls).tokens.input).toEqual({
      knownSum: null,
      knownCount: 0,
      missingCount: 0,
      partialCount: 1,
    });
  });

  it('完整请求耗时包括答案之后的流尾，不用推理时长代替', async () => {
    const { port, rows } = await setup(async () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(controller) {
            const chunk = (value: unknown) =>
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
            chunk({ choices: [{ delta: { reasoning_content: '思考' } }] });
            await new Promise((resolve) => setTimeout(resolve, 5));
            chunk({ choices: [{ delta: { content: '回答' }, finish_reason: 'stop' }] });
            await new Promise((resolve) => setTimeout(resolve, 30));
            chunk({ choices: [], usage: { total_tokens: 7 } });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const response = await port.generate(REQUEST, ACCESS, {
      identity: identity(),
      onDelta: () => {},
    });
    await response.completeObservation?.('accepted');
    const attempt = (await rows())[0].attempts[0];
    expect(attempt.durationMs).toBeGreaterThanOrEqual(25);
    expect(attempt.durationMs! - attempt.thinkingMs!).toBeGreaterThanOrEqual(20);
    expect(attempt.usageComplete).toBe(true);
  });

  it('SDK 发前取消不计实际请求，未知记录不能冒充已发出', async () => {
    const fetch = jest.fn(async () => json({ value: 1 }));
    const { port, stores, rows } = await setup(fetch);
    await expect(
      port.generate(REQUEST, ACCESS, { identity: identity(), signal: AbortSignal.abort() }),
    ).rejects.toThrow('被中止');
    expect(fetch).not.toHaveBeenCalled();
    const pending = await stores.asked.append('g', {
      ...REQUEST,
      model: 'test',
      actionKey: 'a',
      observation: { ...identity(), endpointKey: 'test' },
    });
    await pending!.startAttempt(1);
    expect(costOf(await rows()).requests).toMatchObject({
      dispatched: 0,
      notDispatched: 1,
      unknown: 1,
    });
  });

  it('请求完成的本地记录写失败不会触发新的付费重试', async () => {
    const fetch = jest.fn(async () => json({ value: 1 }));
    const finish = jest.fn(async () => {});
    const port = recordingModelPort(
      retryingModelPort(openaiModelPort({ fetch }), { backoffMs: 0 }),
      async () => ({
        finish,
        startAttempt: async () => {},
        finishAttempt: async () => {
          throw new ModelCallError('transient', '存储失败');
        },
      }),
    );
    await expect(port.generate(REQUEST, ACCESS, { identity: identity() })).rejects.toThrow(
      '观测写入失败',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });
});
