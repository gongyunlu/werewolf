import { ACTION_TYPES } from '@werewolf/shared';
import { snapshotPromptSource, type PromptSource } from '../llm/prompt-template';
import { LOCAL_TURN_PROMPTS, renderGenerate, TURN_PROMPT_NAMES } from './prompt';
import { fingerprint, preparePromptComparison } from './prompt-comparison';
import type { DecisionSnapshot } from './snapshot';

const snapshot: DecisionSnapshot = {
  actionKey: '原行动',
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
    visible: [{ title: '局面', lines: ['还没有警长。'] }],
    skill: ['当时的规则', '当时的角色策略', '当时的场景'],
  },
  prompts: [
    {
      template: TURN_PROMPT_NAMES.generateSystem,
      version: 1,
      source: 'platform',
      text: '历史 system',
    },
    { template: TURN_PROMPT_NAMES.generateUser, version: 7, source: 'platform', text: '历史 user' },
  ],
  draft: '之后生成的答案不属于输入',
  critique: { accept: true, issues: '事后意见' },
  decision: '事后结果',
  reasoning: '事后推理',
  retries: 0,
};
const selection = { name: TURN_PROMPT_NAMES.generateSystem, baseline: 1, candidate: 2 };

function platform(): PromptSource {
  return {
    load: jest.fn(async (name: string, version?: number) => ({
      ...(await LOCAL_TURN_PROMPTS.load(name)),
      source: 'platform' as const,
      version: version ?? 100,
      text: `${(await LOCAL_TURN_PROMPTS.load(name)).text}\n版本 ${version}`,
    })),
  };
}

describe('固定玩家输入对照', () => {
  it('只改变所选模板；规则、skills、玩家输入及另一段的实际版本完全相同', async () => {
    const source = platform();
    const result = await preparePromptComparison(snapshot, source, selection);
    const [a, b] = result.variants;
    expect(source.load).toHaveBeenCalledWith(TURN_PROMPT_NAMES.generateUser, 7);
    expect(source.load).toHaveBeenCalledWith(selection.name, 1);
    expect(source.load).toHaveBeenCalledWith(selection.name, 2);
    expect(a.request.prompt).toBe(b.request.prompt);
    expect(a.request.system.replace('版本 1', '')).toBe(b.request.system.replace('版本 2', ''));
    expect(a.request.system).toContain('当时的场景');
    expect(result.input.context).toEqual(snapshot.context);
    expect(JSON.stringify(result.input)).not.toMatch(/事后|之后生成/);
    expect(fingerprint(JSON.parse(JSON.stringify(result.input)))).toBe(result.inputHash);
    // 标签、源和原对象变化都不能更改已经准备好的请求。
    jest.mocked(source.load).mockRejectedValue(new Error('平台已离线'));
    const saved = JSON.parse(JSON.stringify(a.templates));
    const restored = await renderGenerate(snapshotPromptSource(saved), result.input.context, null);
    expect(restored.system.text).toBe(a.request.system);
    expect(restored.user.text).toBe(a.request.prompt);
  });

  it('也能单独比较 user 模板，system 保持原版本', async () => {
    const result = await preparePromptComparison(snapshot, platform(), {
      ...selection,
      name: TURN_PROMPT_NAMES.generateUser,
    });
    expect(result.variants[0].request.system).toBe(result.variants[1].request.system);
    expect(result.variants[0].request.prompt).not.toBe(result.variants[1].request.prompt);
    expect(result.variants[0].request.primaryPrompt).toBe(TURN_PROMPT_NAMES.generateUser);
  });

  it('缺失版本、错误版本和破坏变量契约的版本都报错，不回退本地', async () => {
    await expect(
      preparePromptComparison(
        snapshot,
        {
          load: async () => {
            throw new Error('不存在');
          },
        },
        selection,
      ),
    ).rejects.toThrow('不存在');
    await expect(preparePromptComparison(snapshot, LOCAL_TURN_PROMPTS, selection)).rejects.toThrow(
      '指定版本',
    );
    const source = platform();
    source.load = async (name, version) => ({
      name,
      version: version!,
      source: 'platform',
      text: '删除了全部变量',
    });
    await expect(preparePromptComparison(snapshot, source, selection)).rejects.toThrow(
      '缺少必需变量',
    );
    await expect(renderGenerate(snapshotPromptSource([]), snapshot.context, null)).rejects.toThrow(
      '固定快照没有',
    );
  });

  it('快照源与调用者隔离，恢复时不查询可变标签', async () => {
    const templates = [
      { name: selection.name, version: 1, text: '旧正文', source: 'platform' as const },
    ];
    const source = snapshotPromptSource(templates);
    templates[0].text = '新正文';
    (await source.load(selection.name)).text = '调用方修改';
    expect((await source.load(selection.name)).text).toBe('旧正文');
    await expect(source.load(selection.name, 2)).rejects.toThrow('所需版本');
  });

  it.each([0, -1, 1.5, Number.NaN])('拒绝非法候选版本 %s', async (candidate) => {
    await expect(
      preparePromptComparison(snapshot, platform(), { ...selection, candidate }),
    ).rejects.toThrow('正整数版本');
  });
});
