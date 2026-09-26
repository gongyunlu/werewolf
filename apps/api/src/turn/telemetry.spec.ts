import { randomUUID } from 'node:crypto';
import type { SpanContext } from '@opentelemetry/api';
import { ROLES } from '@werewolf/shared';
import { loadEnv } from '../config/env';
import {
  access as experienceAccess,
  controlledPort,
  fixture as experienceFixture,
  promptSource,
  result,
  vectorRuntime,
} from '../experience/testing';
import { runExperience } from '../experience/workflow';
import { indexExperience } from '../experience/indexing';
import { INITIAL_KNOWLEDGE } from '../knowledge/initial-content';
import { indexKnowledge, prepareKnowledgeIndex } from '../knowledge/indexing';
import { embeddingKey } from '../llm/embedding';
import { openaiModelPort } from '../llm/openai-model-port';
import { retryingModelPort } from '../llm/retrying-model-port';
import { observeOperation, startTelemetry, stopTelemetry } from '../llm/telemetry';
import { memoryStores } from '../store/memory';
import type { StoredAskedPrompt } from '../store/asked';
import { makeState, stubSkills, withRoles } from '../testing/fixtures';
import { LOCAL_TURN_PROMPTS } from './prompt';
import { modelActions } from './provider';

interface CapturedSpan {
  name: string;
  attributes: Record<string, unknown>;
  parentSpanContext?: SpanContext;
  spanContext(): SpanContext;
}
const mockSpans: CapturedSpan[] = [];
jest.mock('@langfuse/otel', () => {
  const actual = jest.requireActual<typeof import('@langfuse/otel')>('@langfuse/otel');
  return {
    LangfuseSpanProcessor: jest.fn().mockImplementation(
      (params) =>
        new actual.LangfuseSpanProcessor({
          ...params,
          exportMode: 'immediate',
          exporter: {
            export(spans, callback) {
              mockSpans.push(...spans);
              callback({ code: 0 });
            },
            async shutdown() {},
          },
        }),
    ),
  };
});

const access = {
  baseUrl: 'http://offline.invalid/v1',
  model: 'test',
  apiKey: 'private-key',
  capability: { reasoningOff: null, toolStrict: true, streamUsage: true },
};
function field(span: CapturedSpan, name: string): unknown {
  return JSON.parse(span.attributes[`langfuse.observation.${name}`] as string);
}
function parentOf(span: CapturedSpan): CapturedSpan | undefined {
  return mockSpans.find((item) => item.spanContext().spanId === span.parentSpanContext?.spanId);
}

async function fixture(answers: Array<string | number>) {
  const stores = memoryStores();
  const asked: StoredAskedPrompt[] = [];
  const append = stores.asked.append.bind(stores.asked);
  stores.asked.append = async (gameId, row) => {
    asked.push(row);
    return append(gameId, row);
  };
  const state = { ...withRoles(makeState(6), { p1: ROLES.GUARD }), gameId: randomUUID(), day: 3 };
  await stores.games.open({
    gameId: state.gameId,
    boardId: '12p_wolf_king',
    roster: [
      { seatNo: 1, agentId: 'guard-agent', name: '守卫', modelName: access.model, baseUrl: null },
    ],
  });
  const knowledge = await stores.knowledge.saveDraft(
    randomUUID(),
    0,
    INITIAL_KNOWLEDGE[1]!.content,
  );
  const indexer = vectorRuntime();
  indexer.access.apiKey = 'index-key';
  const experience = await experienceFixture(stores);
  experience.input.boardId = '12p_wolf_king';
  experience.input.role = 'guard';
  await runExperience(stores, experience.row.id, {
    port: controlledPort(JSON.stringify(result)),
    access: experienceAccess,
    promptSource,
    prepare: experience.prepare,
  });
  await indexExperience(stores, experience.row.id, indexer);
  await prepareKnowledgeIndex(stores, knowledge.versions[0]!, indexer);
  await indexKnowledge(stores, knowledge.versions[0]!.versionId, indexer);
  await stores.knowledge.activate(
    knowledge.id,
    knowledge.revision,
    knowledge.versions[0]!.versionId,
    embeddingKey(indexer),
  );
  const sent: Record<string, unknown>[] = [];
  const fetch = jest.fn(async (_url, init) => {
    const body = JSON.parse(init?.body as string);
    sent.push(body);
    const answer = 'input' in body ? null : answers.shift();
    if (typeof answer === 'number')
      return new Response('{"error":{"message":"受控失败"}}', {
        status: answer,
        headers: { 'content-type': 'application/json' },
      });
    if (!('input' in body) && answer === undefined) throw new Error('没有准备答复');
    if (body.stream) {
      const chunks = [
        {
          choices: [
            {
              delta: {
                reasoning_content: '受控思考',
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      name: body.tools[0].function.name,
                      arguments: `{"value":${answer}}`,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ];
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(
      JSON.stringify(
        'input' in body
          ? {
              data: [{ index: 0, embedding: [1, 0] }],
              usage: { prompt_tokens: 8, total_tokens: 8 },
            }
          : {
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: '',
                    tool_calls: [
                      {
                        function: {
                          name: body.tools[0].function.name,
                          arguments: `{"value":${answer}}`,
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
      ),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  const port = retryingModelPort(openaiModelPort({ fetch }), { attempts: 2, backoffMs: 0 });
  const runtime = {
    port,
    accessFor: () => access,
    memoriesFor: () => [],
    promptSource: LOCAL_TURN_PROMPTS,
    skills: stubSkills(),
    preview: () => {},
    embedding: { ...indexer, port },
  };
  const actions = () => {
    const provider = modelActions(runtime, stores);
    provider.observe(state);
    return provider;
  };
  return { stores, state, knowledge, sent, fetch, actions, asked };
}

beforeAll(() =>
  startTelemetry({
    ...loadEnv(),
    LANGFUSE_PUBLIC_KEY: 'pk-test',
    LANGFUSE_SECRET_KEY: 'sk-test',
    LANGFUSE_RELEASE: 'test-release',
  }),
);
beforeEach(() => {
  mockSpans.length = 0;
});
afterAll(stopTelemetry);

it('行动串联检索、流式生成、质疑和修订，实际请求与本地快照对应', async () => {
  const f = await fixture(['2', '{"accept":false,"issues":"换一个候选"}', '3']);
  mockSpans.length = 0;
  expect(await f.actions().guardProtect('p1', ['p2', 'p3'])).toBe('p3');
  const root = mockSpans.find((span) => span.name === 'turn.action')!;
  const retrieval = mockSpans.find((span) => span.name === 'references.retrieve')!;
  expect(root).toBeDefined();
  expect(parentOf(retrieval)).toBe(root);
  expect(retrieval.attributes['langfuse.observation.type']).toBe('retriever');
  const retrieved = field(retrieval, 'output') as {
    experiences: { count: number };
    knowledge: { selected: Array<{ versionId: string }>; count: number };
  };
  expect(retrieved.experiences.count).toBe(1);
  expect(retrieved.knowledge.count).toBe(1);
  expect(retrieved.knowledge.selected[0]!.versionId).toBe(f.knowledge.versions[0]!.versionId);
  const generations = mockSpans.filter((span) => span.name.startsWith('model.request.'));
  expect(generations).toHaveLength(4);
  expect(f.fetch).toHaveBeenCalledTimes(4);
  expect(new Set(mockSpans.map((span) => span.spanContext().traceId))).toEqual(
    new Set([root.spanContext().traceId]),
  );
  expect(field(generations[0]!, 'output')).toEqual({ dimensions: 2 });
  expect(parentOf(parentOf(generations[0]!)!)!).toBe(retrieval);
  for (const [index, span] of generations.entries()) {
    expect(field(span, 'input')).toEqual(f.sent[index]);
    expect(JSON.stringify(span.attributes)).toContain('guard-agent');
    expect(span.attributes['langfuse.version']).toBe('test-release');
    expect(span.attributes['langfuse.environment']).toBe('test');
  }
  for (const step of ['generate', 'critique', 'revise', 'finalize']) {
    expect(parentOf(mockSpans.find((span) => span.name === `turn.${step}`)!)).toBe(root);
  }
  const calls = (await f.stores.observations.read(f.state.gameId))!.calls;
  expect(calls).toHaveLength(4);
  for (const row of f.asked.filter(
    (item) => item.actionKey && item.observation?.step !== 'experience_embedding',
  )) {
    const span = generations.find(
      (candidate) =>
        candidate.spanContext().spanId ===
        calls.find((call) => call.callId === row.observation?.callId)?.attempts[0]?.spanId,
    )!;
    expect(field(span, 'input')).toMatchObject({
      messages: [
        { role: 'system', content: row.system },
        { role: 'user', content: row.prompt },
      ],
    });
    expect(field(span, 'output')).toHaveProperty('tool_calls');
    expect(field(span, 'output')).toHaveProperty('reasoning_content', '受控思考');
    expect(field(span, 'input')).toHaveProperty('stream_options.include_usage', true);
  }
  expect(JSON.stringify(mockSpans.map((span) => span.attributes))).not.toMatch(
    /private-key|offline.invalid/,
  );
});

it('中断恢复复用检索与生成；已完成行动重入不再创建观测', async () => {
  const f = await fixture(['2', 400, '{"accept":true,"issues":""}']);
  mockSpans.length = 0;
  await expect(f.actions().guardProtect('p1', ['p2', 'p3'])).rejects.toThrow();
  expect(await f.actions().guardProtect('p1', ['p2', 'p3'])).toBe('p2');
  expect(f.sent.filter((body) => 'input' in body)).toHaveLength(1);
  expect(mockSpans.filter((span) => span.name === 'references.retrieve')).toHaveLength(1);
  expect(mockSpans.filter((span) => span.name === 'references.snapshot')).toHaveLength(1);
  expect(mockSpans.filter((span) => span.name === 'turn.generate')).toHaveLength(1);
  expect(mockSpans.filter((span) => span.name.startsWith('model.request.'))).toHaveLength(4);
  const roots = mockSpans.filter((span) => span.name === 'turn.action');
  expect(roots).toHaveLength(2);
  expect(roots[0]!.spanContext().traceId).not.toBe(roots[1]!.spanContext().traceId);
  const calls = (await f.stores.observations.read(f.state.gameId))!.calls;
  expect(new Set(calls.map((call) => call.actionKey)).size).toBe(1);
  const before = mockSpans.length;
  expect(await f.actions().guardProtect('p1', ['p2', 'p3'])).toBe('p2');
  expect(mockSpans).toHaveLength(before);
  expect(f.fetch).toHaveBeenCalledTimes(4);
});

it('传输重试与格式重问按实际请求记录，重问保留修正后的题面', async () => {
  const f = await fixture([503, '"错误类型"', '2', '{"accept":true,"issues":""}']);
  mockSpans.length = 0;
  expect(await f.actions().guardProtect('p1', ['p2', 'p3'])).toBe('p2');
  const requests = mockSpans.filter((span) => span.name.startsWith('model.request.'));
  expect(requests).toHaveLength(5);
  expect(f.fetch).toHaveBeenCalledTimes(5);
  expect(field(requests[1]!, 'input')).toEqual(field(requests[2]!, 'input'));
  expect(JSON.stringify(field(requests[3]!, 'input'))).toContain('上一次交的');
  expect(field(requests[3]!, 'input')).toEqual(f.sent[3]);
  expect(requests[1]!.attributes['langfuse.observation.output']).toBeUndefined();
});

it('并发观测上下文隔离，业务异常不会触发第二次执行', async () => {
  const run = jest.fn(async () => {
    throw new Error('业务异常');
  });
  await expect(observeOperation('failed', 'chain', {}, run)).rejects.toThrow('业务异常');
  expect(run).toHaveBeenCalledTimes(1);
  await Promise.all(
    ['a', 'b'].map((id) =>
      observeOperation(id, 'agent', {}, async () => {
        await Promise.resolve();
        await observeOperation(`${id}.child`, 'chain', {}, async () => undefined);
      }),
    ),
  );
  for (const id of ['a', 'b']) {
    expect(parentOf(mockSpans.find((span) => span.name === `${id}.child`)!)).toBe(
      mockSpans.find((span) => span.name === id),
    );
  }
});
