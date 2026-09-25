import { ACTION_TYPES } from '@werewolf/shared';
import { prepareEvidence } from './evidence';
import { reviewFixture } from './testing';

describe('复盘证据边界', () => {
  it('保留行动实际使用的历史判断及其主观标签，日终本身不增加自动评价任务', async () => {
    const { stores, action } = await reviewFixture();
    const original = (await stores.actions.find(action.actionKey))!.outcome as {
      snapshot: { context: object };
    };
    const previousJudgment = {
      actionKey: '日终',
      day: 1,
      ledgerSeq: 0,
      assessment: '暂时信任2号',
      changes: '',
    };
    await stores.actions.finish(action.actionKey, {
      decision: 2,
      snapshot: {
        ...original.snapshot,
        context: { ...original.snapshot.context, previousJudgment },
      },
    });
    await stores.actions.begin({
      ...action,
      actionKey: '日终',
      actionType: ACTION_TYPES.DAY_END_JUDGMENT,
    });
    const evidence = await prepareEvidence(stores, 'g');
    expect(evidence.targets).toHaveLength(1);
    expect(evidence.gaps).toEqual([]);
    expect(evidence.targets[0].sources).toContainEqual(
      expect.objectContaining({
        origin: { actionKey: action.actionKey, path: 'context/previousJudgment' },
        value: {
          ...previousJudgment,
          meaning: '本人此前的主观判断，不是已确认事实，可以被当前证据推翻',
        },
      }),
    );
  });
  it('全知分析携带实际保存的板子规则，不用当前规则重建历史', async () => {
    const { stores } = await reviewFixture();
    const evidence = await prepareEvidence(stores, 'g');
    expect(evidence.formatVersion).toBe(2);
    expect(evidence.omniscient).toContainEqual({
      id: 'g/rules/0',
      origin: { path: 'boardRules' },
      value: '村民找狼',
    });
  });

  it('后续身份、赛果及事件不改变早期决策题面', async () => {
    const { stores, state } = await reviewFixture();
    const first = await prepareEvidence(stores, 'g');
    await stores.games.finish('g', 'wolves', {
      ...state,
      players: state.players.map((p) => ({ ...p, role: 'werewolf' as const })),
    });
    await stores.events.append('g', {
      seq: 9,
      eventKey: 'later',
      day: 3,
      text: '终局才揭晓的秘密',
      kind: 'system',
      audience: [],
    });
    const later = await prepareEvidence(stores, 'g');
    expect(later.targets[0]).toEqual(first.targets[0]);
    expect(JSON.stringify(later.targets[0])).not.toContain('终局才揭晓的秘密');
    expect(later.omniscient).not.toEqual(first.omniscient);
  });

  it('保留实际看过的摘要与策略，不补原文或当回合质疑', async () => {
    const { stores } = await reviewFixture();
    const evidence = await prepareEvidence(stores, 'g');
    const text = JSON.stringify(evidence.targets[0]);
    expect(text).toContain('当时的摘要');
    expect(text).toContain('人设策略');
    expect(text).not.toContain('未看过的原文');
    expect(text).not.toContain('质疑者私有评价');
  });

  it('保留当时的决定结构，座位候选不排除结构允许的空操作', async () => {
    const { stores, action } = await reviewFixture();
    const original = (await stores.actions.find(action.actionKey))!.outcome as {
      snapshot: object;
    };
    const schema = { anyOf: [{ type: 'number', enum: [2] }, { type: 'null' }] };
    await stores.actions.finish(action.actionKey, {
      decision: 2,
      snapshot: { ...original.snapshot, schema },
    });
    const evidence = await prepareEvidence(stores, 'g');
    expect(evidence.targets[0]!.sources).toContainEqual({
      id: `g/action/${action.actionKey}/schema`,
      origin: { actionKey: action.actionKey, path: 'schema' },
      value: schema,
    });
  });

  it('未完成与未发布发言列为缺口；同名事件不能冒充行动事件', async () => {
    const { stores, action } = await reviewFixture();
    await stores.actions.begin({ ...action, actionKey: 'running' });
    await stores.actions.begin({ ...action, actionKey: 'speech', actionType: ACTION_TYPES.SPEECH });
    const original = (await stores.actions.find(action.actionKey))!.outcome as { snapshot: object };
    await stores.actions.finish('speech', {
      decision: '未发布草稿',
      snapshot: {
        ...original.snapshot,
        actionKey: 'speech',
        actionType: ACTION_TYPES.SPEECH,
        decision: '未发布草稿',
      },
    });
    const evidence = await prepareEvidence(stores, 'g');
    expect(evidence.targets).toHaveLength(1);
    expect(evidence.gaps.map((g) => g.actionKey)).toEqual(['running', 'speech']);
  });

  it('未结束对局不能复盘', async () => {
    const { stores } = await reviewFixture();
    await stores.games.open({ gameId: 'open', boardId: 'test', roster: [] });
    await expect(prepareEvidence(stores, 'open')).rejects.toThrow('结束');
  });

  it('两份自爆回答仍是两份提议，不生成两次生效事件', async () => {
    const { stores, action } = await reviewFixture();
    const original = (await stores.actions.find('a'))!.outcome as {
      snapshot: { context: { actor: object } };
    };
    for (const [index, actorId] of ['p1', 'p2'].entries()) {
      const actionKey = `blast-${actorId}`;
      await stores.actions.begin({
        ...action,
        actorId,
        actionKey,
        actionType: ACTION_TYPES.WOLF_EXPLODE,
      });
      await stores.actions.finish(actionKey, {
        decision: true,
        snapshot: {
          ...original.snapshot,
          actionKey,
          actorId,
          actionType: ACTION_TYPES.WOLF_EXPLODE,
          decision: true,
          context: {
            ...original.snapshot.context,
            actor: { playerId: actorId, seatNo: index + 1, role: '狼人' },
          },
        },
      });
    }
    await stores.events.append('g', {
      seq: 2,
      eventKey: 'resolved',
      day: 1,
      text: '2 号自爆',
      kind: 'system',
      audience: ['p1', 'p2'],
    });
    const evidence = await prepareEvidence(stores, 'g');
    expect(
      evidence.targets.filter((target) => target.actionType === ACTION_TYPES.WOLF_EXPLODE),
    ).toHaveLength(2);
    const proposals = evidence.omniscient.filter((source) =>
      source.id.includes('/proposal/blast-'),
    );
    expect(proposals).toHaveLength(2);
    expect(
      proposals.every((source) =>
        (source.value as { meaning: string }).meaning.includes('不代表规则实际执行'),
      ),
    ).toBe(true);
    expect(
      evidence.omniscient.filter((source) => 'seq' in source.origin && source.origin.seq === 2),
    ).toHaveLength(1);
  });
});
