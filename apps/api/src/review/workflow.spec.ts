import { analysisOf, unitInput, type ReviewAnalysis, type ReviewUnit } from './contracts';
import { readReview, readReviewState, runReview } from './workflow';
import { reviewFixture } from './testing';
import type { ReviewPlatform, ReviewProfile } from './platform';

function fakePlatform() {
  const inputs = new Map<string, ReviewUnit>();
  const profile: ReviewProfile = {
    evaluatorId: 'e',
    evaluatorVersion: 1,
    ruleId: 'r',
    fingerprint: 'f',
  };
  const platform = {
    profile: jest.fn(async () => profile),
    exists: jest.fn(async (unit: ReviewUnit) => inputs.has(unit.key)),
    submit: jest.fn(async (unit: ReviewUnit) => {
      inputs.set(unit.key, structuredClone(unit));
    }),
    result: jest.fn(async (unit: ReviewUnit) => {
      if (!inputs.has(unit.key)) return null;
      return analysisOf(
        unit,
        `基于当时证据的判断 [证据:${unitInput(unit).sources[0]!.id}]`,
        `score/${unit.key}`,
        `trace/${unit.key}`,
      );
    }),
    wait: jest.fn(
      async (unit: ReviewUnit): Promise<ReviewAnalysis> => (await platform.result(unit))!,
    ),
    generations: jest.fn(async () => []),
  } satisfies ReviewPlatform;
  return { platform, inputs, profile };
}

describe('Langfuse 复盘编排', () => {
  it('模型全由平台执行，局部输入隔离未来信息，缺证据玩家不调用', async () => {
    const { stores } = await reviewFixture();
    const { platform, inputs } = fakePlatform();
    const report = (await runReview(stores, 'g', platform))!;
    expect(platform.submit).toHaveBeenCalledTimes(3);
    expect(report.completedAt).not.toBeNull();
    const decision = JSON.stringify(inputs.get('decision/a'));
    expect(decision).toContain('当时的摘要');
    expect(decision).toContain('人设策略');
    expect(decision).not.toContain('未看过的原文');
    expect(decision).not.toContain('质疑者私有评价');
    expect(decision).not.toContain('finalState');
    const player = JSON.stringify(inputs.get('player/p1'));
    expect(player).toContain('基于当时证据的判断');
    expect(player).not.toContain('未看过的原文');
    expect(JSON.stringify(inputs.get('outcome'))).toContain('未看过的原文');
    expect(report.players[1]).toMatchObject({
      playerId: 'p2',
      result: null,
      limitation: expect.stringContaining('没有可评价'),
    });
    expect((await stores.observations.read('g'))!.calls).toHaveLength(0);
    expect((await stores.games.find('g'))!.status).toBe('finished');
  });

  it('先保存提交凭据再发出请求；响应丢失后只读取，避免重复模型调用', async () => {
    const { stores } = await reviewFixture();
    const { platform, inputs } = fakePlatform();
    platform.submit.mockImplementationOnce(async (unit) => {
      expect((await readReviewState(stores, 'g'))!.pending!.key).toBe(unit.key);
      inputs.set(unit.key, unit);
      throw new Error('响应丢失');
    });
    await expect(runReview(stores, 'g', platform)).rejects.toThrow('响应丢失');
    expect((await readReviewState(stores, 'g'))!.completedAt).toBeNull();
    const report = await runReview(stores, 'g', platform);
    expect(report!.completedAt).not.toBeNull();
    expect(platform.submit.mock.calls.map(([unit]) => unit.key)).toEqual([
      'decision/a',
      'player/p1',
      'outcome',
    ]);
  });

  it('提交是否送达未知时不把查不到当成未提交，不自动重投', async () => {
    const { stores } = await reviewFixture();
    const { platform } = fakePlatform();
    platform.submit.mockRejectedValueOnce(new Error('连接断开'));
    await expect(runReview(stores, 'g', platform)).rejects.toThrow('连接断开');
    await expect(runReview(stores, 'g', platform)).rejects.toThrow('提交状态未知');
    expect(platform.submit).toHaveBeenCalledTimes(1);
  });

  it('首项尚未完成时已评价数为零，输入快照只冻结一次', async () => {
    const { stores } = await reviewFixture();
    const { platform } = fakePlatform();
    platform.wait.mockRejectedValueOnce(new Error('超时'));
    await expect(runReview(stores, 'g', platform)).rejects.toThrow('超时');
    const partial = (await readReview(stores, 'g', platform))!;
    expect(partial.players[0]!.evaluatedDecisions).toBe(0);
    expect((await readReviewState(stores, 'g'))!.receipts).toHaveLength(0);
    await stores.events.append('g', {
      seq: 2,
      eventKey: 'late',
      day: 2,
      kind: 'system',
      text: '冻结后追加的事件',
      audience: ['p1'],
    });
    const report = (await runReview(stores, 'g', platform))!;
    expect(report.players[0]!.evaluatedDecisions).toBe(1);
    expect(JSON.stringify(report.evidence)).not.toContain('冻结后追加的事件');
    const saved = (await readReviewState(stores, 'g'))!;
    expect(saved.pending).toBeNull();
    expect(saved.receipts.every((receipt) => !('sources' in receipt) && !('text' in receipt))).toBe(
      true,
    );
  });

  it('等待超时后续跑复用完成项；读取、重复启动不调用模型', async () => {
    const { stores } = await reviewFixture();
    const { platform } = fakePlatform();
    const wait = platform.wait.getMockImplementation()!;
    platform.wait.mockImplementation(async (unit) => {
      if (unit.step === 'review_player') throw new Error('尚未完成');
      return wait(unit);
    });
    await expect(runReview(stores, 'g', platform)).rejects.toThrow('尚未完成');
    const partial = (await readReview(stores, 'g', platform))!;
    expect(partial.units[0]!.result).not.toBeNull();
    expect(partial.players[0]!.result).toBeNull();
    expect(platform.submit).toHaveBeenCalledTimes(2);
    platform.wait.mockImplementation(wait);
    const report = await runReview(stores, 'g', platform);
    expect(report!.completedAt).not.toBeNull();
    expect(platform.submit).toHaveBeenCalledTimes(3);
    platform.wait.mockClear();
    await readReview(stores, 'g', platform);
    await runReview(stores, 'g', platform);
    expect(platform.submit).toHaveBeenCalledTimes(3);
    expect(platform.wait).not.toHaveBeenCalled();
  });

  it('平台配置改变后拒绝继续，不混合提示词或模型版本', async () => {
    const { stores } = await reviewFixture();
    const { platform, profile } = fakePlatform();
    platform.wait.mockRejectedValueOnce(new Error('超时'));
    await expect(runReview(stores, 'g', platform)).rejects.toThrow('超时');
    platform.profile.mockResolvedValue({ ...profile, fingerprint: 'changed' });
    await expect(runReview(stores, 'g', platform)).rejects.toThrow('配置已改变');
    expect(platform.submit).toHaveBeenCalledTimes(1);
  });

  it('平台改写已接受正文时读取报错，不以本地旧报告冒充平台结果', async () => {
    const { stores } = await reviewFixture();
    const { platform } = fakePlatform();
    await runReview(stores, 'g', platform);
    platform.result.mockImplementation(async (unit) =>
      analysisOf(
        unit,
        `被改写 [证据:${unitInput(unit).sources[0]!.id}]`,
        `score/${unit.key}`,
        `trace/${unit.key}`,
      ),
    );
    await expect(readReview(stores, 'g', platform)).rejects.toThrow('删除或改写');
    expect(platform.submit).toHaveBeenCalledTimes(3);
  });
});
