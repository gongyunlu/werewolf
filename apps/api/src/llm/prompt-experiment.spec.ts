import type { LangfuseClient } from '@langfuse/client';
import type { ExperimentParams } from '@langfuse/client';
import { openaiModelPort } from './openai-model-port';
import { fingerprint, type PromptComparison } from '../turn/prompt-comparison';
import { runPromptExperiment } from './prompt-experiment';

const comparison: PromptComparison = {
  input: {
    context: {
      day: 1,
      actor: { playerId: 'p2', seatNo: 2, role: '预言家' },
      task: '首夜查验',
      visible: [{ title: '当前局面', lines: ['没有公开发言'] }],
      options: ['1 号'],
      skill: ['原规则'],
    },
    schema: null,
    model: 'test-model',
    capability: { reasoningOff: { thinking: { type: 'disabled' } } },
  },
  inputHash: '',
  promptName: 'turn/generate-system',
  variants: [1, 2].map((version) => ({
    label: version === 1 ? 'baseline' : 'candidate',
    templates: [
      { name: 'turn/generate-system', version, source: 'platform', text: `版本 ${version}` },
    ],
    request: {
      system: `版本 ${version} 原规则`,
      prompt: '相同可见信息',
      primaryPrompt: 'turn/generate-system',
      prompts: [
        { name: 'turn/generate-system', version, source: 'platform' },
        { name: 'turn/generate-user', version: 7, source: 'platform' },
      ],
    },
  })),
};
comparison.inputHash = fingerprint(comparison.input);
const access = {
  baseUrl: 'http://offline.invalid',
  model: 'test-model',
  apiKey: 'secret-test',
  capability: comparison.input.capability,
};

function platform() {
  const metadata: unknown[] = [];
  const run = jest.fn(async (params: ExperimentParams) => {
    metadata.push(params.metadata);
    const output = await params.task(params.data[0]);
    return {
      runName: params.runName,
      datasetRunId: 'run-id',
      datasetRunUrl: 'http://localhost/run',
      itemResults: [{ output, traceId: 'trace-id' }],
    };
  });
  const client = {
    api: { datasets: { create: jest.fn(async () => ({})) } },
    dataset: {
      createItem: jest.fn(async ({ input }) => ({
        id: 'item-id',
        datasetId: 'dataset-id',
        input: JSON.parse(JSON.stringify(input)),
      })),
    },
    experiment: { run },
  } as unknown as LangfuseClient;
  return { client, run, metadata };
}

it('使用同一原生 dataset item，出站请求只有所选 prompt 不同；运行中配置修改无效', async () => {
  const remote = platform();
  const bodies: Record<string, unknown>[] = [];
  const mutableAccess = structuredClone(access);
  const port = openaiModelPort({
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      mutableAccess.model = '运行中修改的模型';
      mutableAccess.capability.reasoningOff = null;
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '结果' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const saved: Record<string, unknown>[] = [];
  await runPromptExperiment({
    client: remote.client,
    comparison,
    port,
    access: mutableAccess,
    source: { gameId: 'g', actionKey: 'a' },
    onResult: async (result) => {
      saved.push(result);
    },
  });
  expect(bodies).toHaveLength(2);
  const messages = bodies.map((body) => body.messages as { role: string; content: string }[]);
  expect(messages[0][0].content).toBe('版本 1 原规则');
  expect(messages[1][0].content).toBe('版本 2 原规则');
  expect(messages[0][1]).toEqual(messages[1][1]);
  expect({ ...bodies[0], messages: [] }).toEqual({ ...bodies[1], messages: [] });
  const params = remote.run.mock.calls.map(([call]) => call);
  expect(params[0].data[0]).toBe(params[1].data[0]);
  expect(params[0].metadata?.inputHash).toBe(params[1].metadata?.inputHash);
  expect(params[0].metadata?.conditionsHash).toBe(params[1].metadata?.conditionsHash);
  expect(params.every((call) => !call.evaluators)).toBe(true);
  expect(saved.map((result) => result.modelCalls)).toEqual([1, 1]);
  expect(saved[0].usage).toMatchObject({ input: 10, output: 2, total: 12 });
  expect(JSON.stringify(saved)).not.toContain('secret-test');
});

it('输入被平台改写时，不发起模型请求', async () => {
  const remote = platform();
  jest
    .mocked(remote.client.dataset.createItem)
    .mockResolvedValue({ input: { future: '未来信息' } } as never);
  const port = { generate: jest.fn() };
  await expect(
    runPromptExperiment({
      client: remote.client,
      comparison,
      port,
      access,
      source: { gameId: 'g', actionKey: 'a' },
      onResult: async () => {},
    }),
  ).rejects.toThrow('数据集输入与固定输入不一致');
  expect(port.generate).not.toHaveBeenCalled();
});

it('SDK 吞掉任务失败或未关联 dataset run 时，不报告成功、不继续候选调用', async () => {
  const remote = platform();
  remote.run.mockResolvedValue({ runName: '失败', itemResults: [] } as never);
  const onResult = jest.fn(async () => {});
  await expect(
    runPromptExperiment({
      client: remote.client,
      comparison,
      port: { generate: jest.fn() },
      access,
      source: { gameId: 'g', actionKey: 'a' },
      onResult,
    }),
  ).rejects.toThrow('实验未完整完成');
  expect(remote.run).toHaveBeenCalledTimes(1);
  expect(onResult).toHaveBeenCalledTimes(1);
});

it('真实端口失败只请求一次，不重试也不启动候选', async () => {
  const remote = platform();
  const fetch = jest.fn(async () => new Response('失败', { status: 503 }));
  await expect(
    runPromptExperiment({
      client: remote.client,
      comparison,
      port: openaiModelPort({ fetch }),
      access,
      source: { gameId: 'g', actionKey: 'a' },
      onResult: async () => {},
    }),
  ).rejects.toThrow('模型请求失败');
  expect(fetch).toHaveBeenCalledTimes(1);
});
