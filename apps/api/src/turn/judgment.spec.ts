import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import { ActionsController } from '../actions/actions.controller';
import { phaseInstanceId } from '../core/identity';
import type { StageAnchor } from '../core/loop';
import { patchPlayer } from '../core/state';
import type { ModelPort } from '../llm/model-port';
import { memoryStores } from '../store/memory';
import type { GameStores } from '../store/stores';
import { makeState, stubSkills, withRoles } from '../testing/fixtures';
import { answeringModel, scriptedModel } from '../testing/model';
import { playerAnswer } from '../testing/player';
import { latestJudgment, type PersonalJudgment } from './judgment';
import { LOCAL_TURN_PROMPTS } from './prompt';
import { modelActions } from './provider';
import type { TurnOutcome } from './graph';

function actionsFor(stores: GameStores, port: ModelPort) {
  return modelActions(
    {
      port,
      accessFor: (seatNo) => ({
        baseUrl: 'https://model.example.test/v1',
        model: `玩家${seatNo}`,
        apiKey: '用例',
        capability: { reasoningOff: null },
      }),
      memoriesFor: (seatNo) => [`${seatNo}号的人设`],
      promptSource: {
        load: async (name) => ({
          ...(await LOCAL_TURN_PROMPTS.load(name)),
          source: 'platform',
          version: 7,
        }),
      },
      skills: stubSkills(),
    },
    stores,
  );
}

async function fixture() {
  const stores = memoryStores();
  let state = withRoles(makeState(6, false), {
    p1: ROLES.WEREWOLF,
    p2: ROLES.WEREWOLF,
    p3: ROLES.SEER,
    p4: ROLES.WITCH,
  });
  state = patchPlayer(state, 'p3', { checkedIds: ['p1'] });
  state = patchPlayer(state, 'p6', {
    isAlive: false,
    deathDay: 1,
    deathCause: DEATH_CAUSES.EXECUTION,
  });
  state = { ...state, phaseInstanceId: phaseInstanceId(5, 'dayEnd') };
  await stores.games.open({ gameId: state.gameId, boardId: '12p_wolf_king', roster: [] });
  for (const event of [
    {
      text: '4 号发言：我声称自己是预言家，1 号是好人。',
      kind: 'public_speech' as const,
      audience: state.players.map((p) => p.id),
    },
    { text: '狼队密谈：今晚伪装查验。', kind: 'wolf_speech' as const, audience: ['p1', 'p2'] },
    { text: '6 号被放逐出局。', kind: 'system' as const, audience: state.players.map((p) => p.id) },
  ]) {
    const seq = (await stores.events.list('g1')).length + 1;
    await stores.events.append('g1', { ...event, seq, eventKey: `事件${seq}`, day: 1 });
  }
  const anchor: StageAnchor = { state, phaseInstanceId: state.phaseInstanceId, input: {} };
  return { stores, state, anchor };
}

function judgingModel(prefix = '旧判断', changes = '') {
  return answeringModel((request) => {
    if (!JSON.stringify(request.tool ?? {}).includes('assessment')) return playerAnswer(request);
    const seatNo = request.system.match(/坐 (\d+) 号/)![1];
    return JSON.stringify({
      assessment: `${prefix}-${seatNo}：暂时怀疑4号的身份主张，仍需核对。`,
      changes,
    });
  });
}

describe('日终个人判断链路', () => {
  it('只整理存活玩家的可见材料，私有结果不写入任何发言频道，并保留调用来源', async () => {
    const { stores, anchor } = await fixture();
    const model = judgingModel();
    const actions = actionsFor(stores, model);
    await actions.recordStage(anchor);
    await actions.judgeDayEnd();
    expect(model.calls).toHaveLength(5);
    const seer = model.calls.find((call) => call.system.includes('坐 3 号'))!;
    expect(seer.prompt).toContain('你验过 1 号，是狼人');
    expect(seer.prompt).toContain('4 号发言：我声称');
    expect(seer.prompt).not.toContain('狼队密谈');
    for (const call of model.calls.filter((request) => !request.system.includes('坐 3 号'))) {
      expect(call.prompt).not.toContain('你验过 1 号');
    }
    for (const call of model.calls.filter((request) => !/坐 [12] 号/.test(request.system))) {
      expect(call.prompt).not.toContain('狼队密谈');
      expect(call.prompt).not.toContain('你的狼队友');
    }
    expect(await stores.events.list('g1')).toHaveLength(3);
    const rows = await stores.actions.list('g1');
    expect(rows.every((row) => row.ledgerSeq === 3 && row.status === 'done')).toBe(true);
    expect(rows.map((row) => row.actorId)).not.toContain('p6');
    const observations = (await stores.observations.read('g1'))!;
    for (const row of rows) {
      const { snapshot } = row.outcome as TurnOutcome;
      expect(snapshot.preset).toBe('quick');
      expect(snapshot.critique).toBeNull();
      expect(snapshot.sourceCallId).toEqual(expect.any(String));
      expect(
        snapshot.prompts.every((prompt) => prompt.source === 'platform' && prompt.version === 7),
      ).toBe(true);
      expect(observations.calls).toContainEqual(
        expect.objectContaining({
          callId: snapshot.sourceCallId,
          actionKey: row.actionKey,
          step: 'generate',
        }),
      );
    }
    const api = new ActionsController(stores);
    const history = await api.summaries('g1');
    expect(history.actions).toHaveLength(5);
    expect(history.actions[0]).toMatchObject({
      phase: 'dayEnd',
      day: 1,
      ledgerSeq: 3,
      eventSeq: null,
    });
    expect(
      (await api.detail('g1', rows[0].actionKey)).steps.some((step) => step.name === 'generate'),
    ).toBe(true);
    await expect(api.detail('另一局', rows[0].actionKey)).rejects.toThrow('没有这条行动记录');
  });

  it('后续行动读取本人最近的持久判断，新证据可更新判断且不累加历史', async () => {
    const { stores, anchor, state } = await fixture();
    const initial = actionsFor(stores, judgingModel());
    await initial.recordStage(anchor);
    await initial.judgeDayEnd();

    const nextModel = judgingModel('新判断', '4号新发言解释了疑点，我撤回原先的怀疑。');
    const next = actionsFor(stores, nextModel);
    next.observe({ ...state, day: 2, phaseInstanceId: phaseInstanceId(6, 'night') });
    await next.wolfProposal('p1', ['p3', 'p4', 'p5']);
    expect(nextModel.calls[0].prompt).toContain('旧判断-1');
    expect(nextModel.calls[0].prompt).not.toContain('旧判断-2');
    expect(nextModel.calls[0].prompt).toContain('不是已确认事实');
    expect(nextModel.calls[0].prompt).toContain('允许改变立场');
    expect(nextModel.calls[0].prompt).toContain('4 号发言：我声称');
    expect(
      next
        .outcomes()[0]
        .snapshot.context.visible.some((block) =>
          block.lines.some((line) => line.includes('旧判断-1')),
        ),
    ).toBe(false);

    await stores.events.append('g1', {
      seq: 4,
      eventKey: '新证据',
      day: 2,
      kind: 'public_speech',
      text: '4 号发言：我撤回昨天的查验主张。',
      audience: state.players.map((p) => p.id),
    });
    // 新适配器模拟后续阶段重新载入台账和已保存判断。
    const updated = actionsFor(stores, nextModel);
    const day2 = { ...state, day: 2, phaseInstanceId: phaseInstanceId(9, 'dayEnd') };
    await updated.recordStage({ state: day2, phaseInstanceId: day2.phaseInstanceId, input: {} });
    await updated.judgeDayEnd();
    const day2Judgments = updated.outcomes();
    expect(day2Judgments.every((row) => row.snapshot.context.previousJudgment?.day === 1)).toBe(
      true,
    );
    expect(day2Judgments[0].snapshot.prompts[1].text).toContain('我撤回昨天的查验主张');

    const latestModel = judgingModel();
    const restored = actionsFor(stores, latestModel);
    restored.observe({ ...state, day: 3, phaseInstanceId: phaseInstanceId(10, 'night') });
    await restored.wolfProposal('p1', ['p3', 'p4', 'p5']);
    expect(latestModel.calls[0].prompt).toContain('新判断-1');
    expect(latestModel.calls[0].prompt).not.toContain('旧判断-1');
    expect(latestModel.calls[0].prompt).not.toContain('新判断-2');
    expect(restored.outcomes()[0].snapshot.context.previousJudgment).toMatchObject({
      day: 2,
      ledgerSeq: 4,
    });
  });

  it('部分玩家失败或尚未立意图时恢复，只重做缺失结果，所有人仍用原日终边界', async () => {
    const { stores, anchor } = await fixture();
    const begin = stores.actions.begin.bind(stores.actions);
    stores.actions.begin = async (intent) => {
      if (intent.actorId === 'p3') throw new Error('立意图时中断');
      return begin(intent);
    };
    const failing = answeringModel((request) => {
      if (request.system.includes('坐 2 号')) throw new Error('调用中断');
      return playerAnswer(request);
    });
    const initial = actionsFor(stores, failing);
    await initial.recordStage(anchor);
    await expect(initial.judgeDayEnd()).rejects.toThrow('调用中断');
    const completed = (await stores.actions.list('g1')).filter((row) => row.status === 'done');
    expect(completed).toHaveLength(3);
    stores.actions.begin = begin;
    await stores.events.append('g1', {
      seq: 4,
      eventKey: '未来',
      day: 2,
      kind: 'system',
      text: '未来夜间结果，不应读到',
      audience: ['p1', 'p2', 'p3', 'p4', 'p5'],
    });
    const model = judgingModel();
    const resumed = actionsFor(stores, model);
    const savedAnchor = (await stores.steps.last('g1'))!;
    expect(savedAnchor.input).toEqual({ ledgerSeq: 3 });
    await resumed.recordStage(savedAnchor);
    await resumed.judgeDayEnd();
    expect(model.calls).toHaveLength(2);
    expect(model.calls.every((call) => !call.prompt.includes('未来夜间结果'))).toBe(true);
    for (const row of completed) expect(await stores.actions.find(row.actionKey)).toEqual(row);
    expect(
      (await stores.actions.list('g1')).every(
        (row) => row.status === 'done' && row.ledgerSeq === 3,
      ),
    ).toBe(true);
    await resumed.judgeDayEnd();
    expect(model.calls).toHaveLength(2);
  });

  it('生成检查点已完成但行动结果落库失败，恢复从检查点取回而不再次调用模型', async () => {
    const { stores, anchor } = await fixture();
    const finish = stores.actions.finish.bind(stores.actions);
    stores.actions.finish = async (key, outcome) => {
      if ((outcome as TurnOutcome).snapshot.actorId === 'p2') throw new Error('结果落库中断');
      return finish(key, outcome);
    };
    const initial = actionsFor(stores, judgingModel());
    await initial.recordStage(anchor);
    await expect(initial.judgeDayEnd()).rejects.toThrow('结果落库中断');
    stores.actions.finish = finish;
    const model = scriptedModel([]);
    const resumed = actionsFor(stores, model);
    await resumed.recordStage((await stores.steps.last('g1'))!);
    await resumed.judgeDayEnd();
    expect(model.calls).toHaveLength(0);
    expect((await stores.actions.list('g1')).every((row) => row.status === 'done')).toBe(true);
  });

  it('格式或长度错误沿用格式重试，不静默截断或把主观质量作为重试条件', async () => {
    const { stores, state, anchor } = await fixture();
    const solo = {
      ...state,
      players: state.players.map((p) => ({ ...p, isAlive: p.id === 'p5' })),
    };
    const model = scriptedModel([
      JSON.stringify({ assessment: '过'.repeat(1601), changes: '' }),
      JSON.stringify({ assessment: '我仍怀疑1号，但也可能被误导。', changes: '' }),
    ]);
    const actions = actionsFor(stores, model);
    await actions.recordStage({ ...anchor, state: solo });
    await actions.judgeDayEnd();
    expect(model.calls).toHaveLength(2);
    expect(actions.outcomes()[0].snapshot.retries).toBe(1);
  });
});

describe('历史判断的归属和时点', () => {
  it('排除其他局、其他玩家、当日及未来判断和越过截止位置的记录，只取最近一份', () => {
    const base: PersonalJudgment = {
      gameId: 'g1',
      actorId: 'p1',
      actionKey: '第一天',
      day: 1,
      ledgerSeq: 2,
      assessment: '此前推测',
      changes: '',
    };
    const second = { ...base, actionKey: '第二天', day: 2, ledgerSeq: 3 };
    const judgments = [
      base,
      second,
      { ...base, gameId: 'g2', day: 2, assessment: '其他局' },
      { ...base, actorId: 'p2', day: 2, assessment: '其他玩家' },
      { ...base, day: 3, assessment: '当日日终' },
      { ...base, day: 9, assessment: '未来日期' },
      { ...base, day: 2, ledgerSeq: 10, assessment: '未来事件' },
    ];
    expect(latestJudgment(judgments, { ...makeState(6), day: 3 }, 'p1', 3)).toEqual({
      actionKey: '第二天',
      day: 2,
      ledgerSeq: 3,
      assessment: '此前推测',
      changes: '',
    });
    expect(latestJudgment(judgments, makeState(6), 'p1', 3)).toBeUndefined();
  });
});
