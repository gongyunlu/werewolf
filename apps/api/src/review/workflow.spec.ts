import { analysisOf, unitInput } from './contracts';
import { readReview, readReviewState, runReview } from './workflow';
import { fakeReviewPlatform as fakePlatform, reviewFixture } from './testing';
import { reviewPreview, prepareEvidence } from './evidence';

describe('Langfuse 复盘编排', () => {
  it('不同对局的同名玩家与全知单元使用不同的观测标识', async () => {
    const first = await reviewFixture('g1');
    const second = await reviewFixture('g2');
    const one = (await runReview(first.stores, 'g1', fakePlatform().platform))!;
    const two = (await runReview(second.stores, 'g2', fakePlatform().platform))!;
    const ids = [...one.units, ...two.units].map((unit) => unit.spanId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('玩家汇总能用原始快照核对局部评价，不把模型意见升级为事实', async () => {
    const { stores } = await reviewFixture();
    const { platform, inputs } = fakePlatform();
    const result = platform.result.getMockImplementation()!;
    platform.result.mockImplementation(async (unit) =>
      unit.step === 'review_decision'
        ? analysisOf(unit, '第 5 天，玩家已确认是预言家 [E1]。', 'score/a', 'trace/a')
        : result(unit),
    );
    await runReview(stores, 'g', platform);
    const player = inputs.get('player/p1')!;
    expect(player.sources[0]!.value).toMatchObject({
      day: 1,
      actionType: 'vote',
      assessment: '第 5 天，玩家已确认是预言家 [E1]。',
      evidence: expect.arrayContaining([
        expect.objectContaining({
          origin: { path: 'context/actor' },
          value: { playerId: 'p1', seatNo: 1, role: '村民' },
        }),
        expect.objectContaining({ origin: { path: 'context/day' }, value: 1 }),
      ]),
    });
    const input = JSON.stringify(unitInput(player));
    expect(input).not.toContain('score/a');
    expect(input).not.toContain('trace/a');
    expect(input).not.toContain('未看过的原文');
    expect(input).not.toContain('质疑者私有评价');
  });

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

  it('十二人多轮材料完成全部评价，玩家汇总只包含自己的决定', async () => {
    const { stores, state, action } = await reviewFixture();
    state.players = Array.from({ length: 12 }, (_, index) => ({
      ...state.players[0]!,
      id: `p${index + 1}`,
      seatNo: index + 1,
    }));
    state.day = 6;
    await stores.games.finish('g', 'good', state);
    // 仅用于编排容量：十二人各六条决定，不模拟真实存活与出局过程。
    for (let index = 1; index < 72; index++) {
      const seatNo = (index % 12) + 1;
      const day = Math.floor(index / 12) + 1;
      const actionKey = `a${index}`;
      const actorId = `p${seatNo}`;
      const decision = (seatNo % 12) + 1;
      await stores.actions.begin({
        ...action,
        actionKey,
        actorId,
        phaseInstanceId: `${day}/vote`,
        ledgerSeq: index + 1,
      });
      await stores.actions.finish(actionKey, {
        decision,
        snapshot: {
          actionKey,
          actionType: action.actionType,
          actorId,
          sourceCallId: `call/${actionKey}`,
          decision,
          reasoning: '保留不确定性',
          context: {
            task: '投票',
            actor: { playerId: actorId, seatNo, role: '村民' },
            day,
            visible: [{ title: '本人当时可见摘要', lines: ['当前尚未确认身份。'.repeat(300)] }],
            options: [`${decision} 号`],
            skill: ['根据当时的公开证据决策'],
          },
        },
      });
    }
    const preview = reviewPreview(await prepareEvidence(stores, 'g'));
    expect(preview).toMatchObject({ decisions: 72, players: 12, expectedLogicalCalls: 85 });
    expect(preview.evidenceCharacters.decisions).toBeGreaterThan(200_000);
    const { platform, inputs } = fakePlatform();
    const report = (await runReview(stores, 'g', platform))!;
    expect(report.completedAt).not.toBeNull();
    expect(report.units).toHaveLength(85);
    expect(platform.submit).toHaveBeenCalledTimes(85);
    expect(new Set(report.units.map((unit) => unit.traceId)).size).toBe(85);
    for (const player of state.players) {
      const keys = report.evidence.targets
        .filter((target) => target.actorId === player.id)
        .map((target) => ({ actionKey: target.actionKey, path: 'review' }));
      const unit = inputs.get(`player/${player.id}`)!;
      expect(unit.sources.map((source) => source.origin)).toEqual(keys);
      expect(unit.sources).toHaveLength(6);
      expect(report.players.find((item) => item.playerId === player.id)!.evaluatedDecisions).toBe(
        6,
      );
    }
    const saved = (await readReviewState(stores, 'g'))!;
    expect(saved.pending).toBeNull();
    expect(saved.receipts).toHaveLength(85);
    expect(saved.receipts.every((receipt) => !('sources' in receipt) && !('text' in receipt))).toBe(
      true,
    );
    await runReview(stores, 'g', platform);
    expect(platform.submit).toHaveBeenCalledTimes(85);
  }, 30_000);
});
