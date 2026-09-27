import type { LangfuseClient } from '@langfuse/client';
import { ACTION_TYPES } from '@werewolf/shared';
import type { DecisionSnapshot } from '../turn/snapshot';
import { comparisonInput, fingerprint } from '../turn/prompt-comparison';
import {
  assertPromptSample,
  sampleMetadata,
  savePromptSample,
  type PromptDatasetItem,
} from './prompt-sample';

const snapshot: DecisionSnapshot = {
  actionKey: '行动键',
  actionType: ACTION_TYPES.SPEECH,
  actorId: 'p2',
  actionOrdinal: 0,
  preset: 'quick',
  model: '测试模型',
  capability: { reasoningOff: null },
  schema: null,
  context: {
    actor: { playerId: 'p2', seatNo: 2, role: '预言家' },
    day: 1,
    task: '根据当前信息发言',
    options: [],
    visible: [{ title: '局面', lines: ['当前可见事实'] }],
    skill: ['当时的规则'],
  },
  prompts: [{ template: 'turn/generate-system', version: 3, source: 'platform', text: '原提示词' }],
  draft: '事后答案',
  critique: null,
  decision: '事后决定',
  reasoning: '事后推理',
  retries: 0,
};
const source = {
  gameId: 'g1',
  actionKey: snapshot.actionKey,
  callId: 'c1',
  traceId: 't1',
  observationId: 'o1',
};
const feedback = { category: 'fact' as const, note: '人工意见包含事后答案，不能输入给玩家' };

function platform() {
  const items = new Map<string, PromptDatasetItem>();
  const create = jest.fn(async () => ({}));
  const createItem = jest.fn(async (request) => {
    const item = {
      ...structuredClone(request),
      status: 'ACTIVE',
      datasetId: 'dataset',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    items.set(item.id, item);
    return item;
  });
  return {
    client: { api: { datasets: { create } }, dataset: { createItem } } as unknown as LangfuseClient,
    create,
    createItem,
    items,
  };
}

it('保存当时输入及来源；人工意见和结果只在输入之外，重复保存更新说明', async () => {
  const remote = platform();
  const args = {
    client: remote.client,
    datasetName: 'werewolf/action-samples',
    snapshot,
    source,
    feedback,
  };
  const first = await savePromptSample(args);
  const second = await savePromptSample({
    ...args,
    feedback: { category: 'reference', note: '补充后的说明' },
  });
  expect(first.id).toBe(second.id);
  expect(remote.items.size).toBe(1);
  expect(second.input).toEqual(comparisonInput(snapshot));
  expect(JSON.stringify(second.input)).not.toMatch(/事后|人工意见|补充后的说明/);
  expect(second).not.toHaveProperty('expectedOutput');
  expect(second.sourceTraceId).toBe('t1');
  expect(second.sourceObservationId).toBe('o1');
  expect(sampleMetadata(second).feedback.note).toBe('补充后的说明');
  expect(first.metadata).toMatchObject({
    prompts: [{ name: 'turn/generate-system', version: 3, source: 'platform' }],
  });
});

it('相同输入来自不同对局或存入不同集合时，不覆盖其他样本', async () => {
  const remote = platform();
  const args = { client: remote.client, datasetName: 'samples', snapshot, source, feedback };
  await savePromptSample(args);
  await savePromptSample({ ...args, source: { ...source, gameId: 'g2' } });
  await savePromptSample({ ...args, datasetName: 'other' });
  expect(remote.items.size).toBe(3);
});

it('平台输入和本地原行动不一致时拒绝，包括输入与指纹一起被修改', async () => {
  const remote = platform();
  const item = await savePromptSample({
    client: remote.client,
    datasetName: 'samples',
    snapshot,
    source,
    feedback,
  });
  const metadata = sampleMetadata(item);
  item.input = {
    ...comparisonInput(snapshot),
    context: { ...snapshot.context, visible: [{ title: '未来', lines: ['事后信息'] }] },
  };
  expect(() => sampleMetadata(item)).toThrow('输入已被修改');
  item.metadata = { ...metadata, inputHash: fingerprint(item.input) };
  expect(() => assertPromptSample(item, comparisonInput(snapshot), source)).toThrow(
    '与原行动输入或来源不一致',
  );
});

it('归档或来源引用被修改的样本拒绝复用', async () => {
  const remote = platform();
  const item = await savePromptSample({
    client: remote.client,
    datasetName: 'samples',
    snapshot,
    source,
    feedback,
  });
  expect(() => sampleMetadata({ ...item, status: 'ARCHIVED' })).toThrow('已归档');
  expect(() =>
    assertPromptSample(
      { ...item, sourceTraceId: '另一个trace' },
      comparisonInput(snapshot),
      source,
    ),
  ).toThrow('来源不一致');
  expect(() =>
    assertPromptSample(item, comparisonInput(snapshot), { ...source, gameId: 'g2' }),
  ).toThrow('来源不一致');
});

it('无效说明或缺失工具在平台写入之前失败', async () => {
  const remote = platform();
  const args = { client: remote.client, datasetName: 'samples', snapshot, source, feedback };
  await expect(
    savePromptSample({ ...args, feedback: { ...feedback, note: '  ' } }),
  ).rejects.toThrow();
  await expect(
    savePromptSample({ ...args, snapshot: { ...snapshot, schema: { type: 'object' } } }),
  ).rejects.toThrow('工具定义');
  expect(remote.create).not.toHaveBeenCalled();
  expect(remote.createItem).not.toHaveBeenCalled();
});

it('平台保存后的输入发生变化时，不报告保存成功', async () => {
  const remote = platform();
  remote.createItem.mockImplementation(async (request) => ({
    ...request,
    status: 'ACTIVE',
    input: {},
  }));
  await expect(
    savePromptSample({ client: remote.client, datasetName: 'samples', snapshot, source, feedback }),
  ).rejects.toThrow('输入已被修改');
});
