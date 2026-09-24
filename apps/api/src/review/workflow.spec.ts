import type { ModelAccess, ModelPort, ModelRequest } from '../llm/model-port';
import { ModelCallError } from '../llm/model-port';
import { gameStatistics } from '../games/statistics';
import { reviewFixture } from './testing';
import { readReview, runReview } from './workflow';
import { REVIEW_PROMPTS } from './judge';
import { prepareEvidence } from './evidence';
import { AssessmentSchema, validateReferences } from './contracts';

const ACCESS: ModelAccess = {
  model: '评审用例',
  baseUrl: 'https://judge.example.test/v1',
  apiKey: 'test-secret',
  capability: { reasoningOff: null },
};

function answer(request: ModelRequest, ref?: string) {
  const input = JSON.parse(request.prompt.split('\n')[0]!) as { sources: { id: string }[] };
  return {
    summary: {
      text: '基于证据评价，胜负不能证明当时判断好坏',
      refs: [ref ?? input.sources[0]!.id],
    },
    strengths: [],
    issues: [],
    suggestions: [],
    uncertainties: [],
  };
}

function model(failAt = -1, invalidRef?: string) {
  const generate = jest.fn<ReturnType<ModelPort['generate']>, Parameters<ModelPort['generate']>>(
    async (request, _access, call) => {
      const attempt = await call?.startAttempt?.();
      attempt?.dispatched();
      const failed = generate.mock.calls.length === failAt;
      await attempt?.finish({
        status: failed ? 'failed' : 'succeeded',
        failureCode: failed ? 'fatal' : null,
        dispatched: true,
        durationMs: 10,
        thinkingMs: null,
        httpStatus: failed ? 500 : 200,
        requestId: null,
        usage: { total_tokens: 4 },
        usageComplete: true,
      });
      if (failed) throw new ModelCallError('fatal', '评审端点失败');
      return {
        content: '',
        reasoning: null,
        toolCall: {
          name: 'submit',
          arguments: JSON.stringify({ value: answer(request, invalidRef) }),
        },
      };
    },
  );
  return { generate };
}

describe('持久赛后复盘', () => {
  it('逐决定、逐玩家、全知分析各用独立输入，完成后读取与重复运行不调用模型', async () => {
    const { stores } = await reviewFixture();
    const original = structuredClone({
      game: await stores.games.find('g'),
      actions: await stores.actions.list('g'),
      events: await stores.events.list('g'),
    });
    const port = model();
    const report = await runReview(stores, 'g', { port, access: ACCESS });
    expect(report.completedAt).not.toBeNull();
    expect(port.generate).toHaveBeenCalledTimes(3);
    const calls = port.generate.mock.calls;
    expect(calls.map((call) => call[2]!.identity!.step)).toEqual([
      'review_decision',
      'review_player',
      'review_outcome',
    ]);
    expect(calls[0]![0].prompt).not.toContain('finalState');
    expect(calls[1]![0].prompt).not.toContain('终局');
    expect(calls[1]![0].prompt).toContain('/assessment/');
    expect(calls[2]![0].prompt).toContain('game/finalState');
    expect(report.players.find((p) => p.playerId === 'p2')!.result).toBeNull();
    expect(await readReview(stores, 'g')).toEqual(report);
    expect(await runReview(stores, 'g', { port, access: ACCESS })).toEqual(report);
    expect(port.generate).toHaveBeenCalledTimes(3);
    expect({
      game: await stores.games.find('g'),
      actions: await stores.actions.list('g'),
      events: await stores.events.list('g'),
    }).toEqual(original);
    expect(JSON.stringify(report)).not.toMatch(/test-secret|judge\.example/);
    const data = (await stores.observations.read('g'))!;
    const statistics = gameStatistics(data, { limit: 100 });
    expect(statistics.total.logicalCalls).toBe(3);
    expect(statistics.reviewOverhead.tokens.total.knownSum).toBe(12);
    expect(statistics.publicOverhead.logicalCalls).toBe(0);
    expect(statistics.unattributed.logicalCalls).toBe(0);
    expect(statistics.players).toHaveLength(0);
    expect(statistics.calls.every((c) => c.adopted === null && c.taskId && c.checkpointId)).toBe(
      true,
    );
  });

  it('中途失败只续跑未保存的单元，失败不变成玩家问题', async () => {
    const { stores } = await reviewFixture();
    const failed = model(2);
    await expect(runReview(stores, 'g', { port: failed, access: ACCESS })).rejects.toThrow(
      '评审端点失败',
    );
    const saved = (await readReview(stores, 'g'))!;
    expect(saved.decisions).toHaveLength(1);
    expect(saved.players).toHaveLength(0);
    expect(saved.completedAt).toBeNull();
    const resumed = model();
    const final = await runReview(stores, 'g', { port: resumed, access: ACCESS });
    expect(resumed.generate).toHaveBeenCalledTimes(2);
    expect(final.decisions).toEqual(saved.decisions);
    expect(final.players[0]!.result!.assessment.issues).toEqual([]);
    expect((await stores.games.find('g'))!.status).toBe('finished');
    const calls = (await stores.observations.read('g'))!.calls;
    expect(calls).toHaveLength(4);
    expect(calls.filter((call) => call.status === 'failed')).toHaveLength(1);
  });

  it.each(['other-game/event/1', 'g/event/999', 'g/action/another/decision'])(
    '拒绝越界引用 %s，有限格式重问后保留失败',
    async (ref) => {
      const { stores } = await reviewFixture();
      const port = model(-1, ref);
      await expect(runReview(stores, 'g', { port, access: ACCESS })).rejects.toThrow('引用');
      expect(port.generate).toHaveBeenCalledTimes(3);
      expect((await readReview(stores, 'g'))!.decisions).toHaveLength(0);
      const calls = (await stores.observations.read('g'))!.calls;
      expect(calls.map((c) => c.formatAttempt)).toEqual([1, 2, 3]);
      expect(calls.every((c) => c.status === 'invalid_output')).toBe(true);
    },
  );

  it('续跑不能静默更换评审模型', async () => {
    const { stores } = await reviewFixture();
    await expect(runReview(stores, 'g', { port: model(2), access: ACCESS })).rejects.toThrow();
    const port = model();
    await expect(
      runReview(stores, 'g', { port, access: { ...ACCESS, model: '另一模型' } }),
    ).rejects.toThrow('原评审模型');
    expect(port.generate).not.toHaveBeenCalled();
  });

  it('存储往返改变 JSON 字段顺序不被误判为更换评审配置', async () => {
    const { stores } = await reviewFixture();
    await expect(runReview(stores, 'g', { port: model(2), access: ACCESS })).rejects.toThrow();
    const getTuple = stores.checkpoints.getTuple.bind(stores.checkpoints);
    jest.spyOn(stores.checkpoints, 'getTuple').mockImplementation(async (...args) => {
      const tuple = await getTuple(...args);
      const prepared = tuple?.checkpoint.channel_values.prepared as
        { judge: { model: string; endpointKey: string; capability: object } } | undefined;
      if (prepared) {
        const { model: name, endpointKey, capability } = prepared.judge;
        prepared.judge = { capability, endpointKey, model: name };
      }
      return tuple;
    });
    const port = model();
    const report = await runReview(stores, 'g', { port, access: ACCESS });
    expect(report.completedAt).not.toBeNull();
    expect(port.generate).toHaveBeenCalledTimes(2);
  });

  it('已完成局部判断不因后续赛果变更而在续跑时重判', async () => {
    const { stores, state } = await reviewFixture();
    await expect(runReview(stores, 'g', { port: model(2), access: ACCESS })).rejects.toThrow();
    const saved = (await readReview(stores, 'g'))!;
    await stores.games.finish('g', 'werewolf', { ...state, day: 10 });
    const port = model();
    const report = await runReview(stores, 'g', { port, access: ACCESS });
    expect(report.decisions).toEqual(saved.decisions);
    expect(report.evidence).toEqual(saved.evidence);
    expect(
      port.generate.mock.calls.some((call) => call[2]!.identity!.step === 'review_decision'),
    ).toBe(false);
  });

  it('裁判超时保留复盘失败，不改玩家决定或填充默认评价', async () => {
    const { stores } = await reviewFixture();
    const port: ModelPort = {
      generate: async () => {
        throw new ModelCallError('deadline', '超时');
      },
    };
    await expect(runReview(stores, 'g', { port, access: ACCESS })).rejects.toThrow('超时');
    const report = (await readReview(stores, 'g'))!;
    expect(report.decisions).toHaveLength(0);
    expect(report.completedAt).toBeNull();
    expect((await stores.observations.read('g'))!.calls[0]!.status).toBe('cancelled');
    expect((await stores.actions.find('a'))!.status).toBe('done');
  });

  it('观测写入失败不调用模型，不记为玩家失误', async () => {
    const { stores } = await reviewFixture();
    jest.spyOn(stores.asked, 'append').mockRejectedValueOnce(new Error('写库失败'));
    const port = model();
    await expect(runReview(stores, 'g', { port, access: ACCESS })).rejects.toThrow('写库失败');
    expect(port.generate).not.toHaveBeenCalled();
    expect((await readReview(stores, 'g'))!.decisions).toHaveLength(0);
    await runReview(stores, 'g', { port, access: ACCESS });
    expect(port.generate).toHaveBeenCalledTimes(3);
  });

  it('检查点写入失败时，已保存的节点写入在续跑时复用', async () => {
    const { stores } = await reviewFixture();
    const put = stores.checkpoints.put.bind(stores.checkpoints);
    let failed = false;
    jest.spyOn(stores.checkpoints, 'put').mockImplementation(async (...args) => {
      const decisions = args[1].channel_values.decisions as unknown[] | undefined;
      if (!failed && decisions?.length === 1) {
        failed = true;
        throw new Error('检查点故障');
      }
      return put(...args);
    });
    const port = model();
    await expect(runReview(stores, 'g', { port, access: ACCESS })).rejects.toThrow('检查点故障');
    expect(port.generate).toHaveBeenCalledTimes(1);
    const report = await runReview(stores, 'g', { port, access: ACCESS });
    expect(report.completedAt).not.toBeNull();
    expect(port.generate).toHaveBeenCalledTimes(3);
  });

  it('多决定长上下文不会在每个检查点重复保存整局证据', async () => {
    const { stores, action } = await reviewFixture();
    const original = (await stores.actions.find('a'))!.outcome as {
      decision: number;
      snapshot: { context: object };
    };
    for (let i = 1; i < 20; i++) {
      const key = `long-${i}`;
      await stores.actions.begin({ ...action, actionKey: key });
      await stores.actions.finish(key, {
        ...original,
        snapshot: {
          ...original.snapshot,
          actionKey: key,
          context: {
            ...original.snapshot.context,
            visible: [{ title: '发言', lines: ['较长的当时可见证据'.repeat(500)] }],
          },
        },
      });
    }
    const evidenceBytes = Buffer.byteLength(JSON.stringify(await prepareEvidence(stores, 'g')));
    const put = stores.checkpoints.put.bind(stores.checkpoints);
    let totalBytes = 0;
    jest.spyOn(stores.checkpoints, 'put').mockImplementation(async (...args) => {
      totalBytes += Buffer.byteLength(JSON.stringify(args[1]));
      return put(...args);
    });
    await runReview(stores, 'g', { port: model(), access: ACCESS });
    expect(totalBytes).toBeLessThan(evidenceBytes * 6);
  });

  it('准备检查点提交失败后恢复冻结证据，仍在调用前校验评审配置', async () => {
    const { stores, state } = await reviewFixture();
    const put = stores.checkpoints.put.bind(stores.checkpoints);
    let failed = false;
    jest.spyOn(stores.checkpoints, 'put').mockImplementation(async (...args) => {
      if (!failed && args[1].channel_values.prepared) {
        failed = true;
        throw new Error('准备提交失败');
      }
      return put(...args);
    });
    const port = model();
    await expect(runReview(stores, 'g', { port, access: ACCESS })).rejects.toThrow('准备提交失败');
    expect(port.generate).not.toHaveBeenCalled();
    await stores.games.finish('g', 'werewolf', { ...state, day: 10 });
    await expect(
      runReview(stores, 'g', { port, access: { ...ACCESS, model: '另一模型' } }),
    ).rejects.toThrow('原评审模型');
    expect(port.generate).not.toHaveBeenCalled();
    const report = await runReview(stores, 'g', { port, access: ACCESS });
    expect(report.evidence.omniscient.find((source) => source.id === 'g/result')!.value).toBe(
      'good',
    );
    expect(port.generate).toHaveBeenCalledTimes(3);
  });

  it('拒绝数字评分和无引用判断，并声明缺推理、摘要与狼队目标边界', () => {
    const value = {
      summary: { text: '判断', refs: ['a'] },
      strengths: [],
      issues: [],
      suggestions: [],
      uncertainties: [],
    };
    expect(AssessmentSchema.safeParse({ ...value, score: 8 }).success).toBe(false);
    expect(
      AssessmentSchema.safeParse({ ...value, summary: { text: '猜测', refs: [] } }).success,
    ).toBe(false);
    expect(() => validateReferences(value, ['b'])).toThrow();
    expect(REVIEW_PROMPTS.review_decision).toContain('reasoning 为 null 不代表');
    expect(REVIEW_PROMPTS.review_decision).toContain('狼人欺骗');
    expect(REVIEW_PROMPTS.review_decision).toContain('合理判断猜错');
  });
});
