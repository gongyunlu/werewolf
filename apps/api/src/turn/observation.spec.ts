import { ACTION_TYPES } from '@werewolf/shared';
import { z } from 'zod';
import { phaseInstanceId } from '../core/identity';
import { recordingModelPort } from '../llm/recording-model-port';
import { scriptedModel, type ScriptedStep } from '../testing/model';
import { stubSkills } from '../testing/fixtures';
import { memoryStores } from '../store/memory';
import { runActionGraph } from './graph';
import { LOCAL_TURN_PROMPTS } from './prompt';
import { actionKeyOf, type ActionRequest, type TurnRuntime } from './request';

const request: ActionRequest = {
  scope: { gameId: 'g', phaseInstanceId: phaseInstanceId(1, 'vote') },
  actionType: ACTION_TYPES.VOTE,
  actorId: 'p1',
  actionOrdinal: 0,
  preset: 'quality',
  context: {
    task: '投票',
    actor: { playerId: 'p1', seatNo: 1, role: '村民' },
    day: 1,
    visible: [],
    options: ['2 号'],
    skill: [],
  },
  schema: z.number(),
};

async function fixture() {
  const stores = memoryStores();
  await stores.games.open({ gameId: 'g', boardId: 'test', roster: [] });
  const runtime = (answers: ScriptedStep[]): TurnRuntime => ({
    port: recordingModelPort(scriptedModel(answers), (asked) =>
      stores.asked.append('g', { ...asked, actionKey: actionKeyOf(request) }),
    ),
    accessFor: () => ({
      model: 'test',
      baseUrl: 'http://test.invalid',
      apiKey: 'secret',
      capability: { reasoningOff: null },
    }),
    memoriesFor: () => [],
    promptSource: LOCAL_TURN_PROMPTS,
    skills: stubSkills(),
  });
  const rows = async () => (await stores.observations.read('g'))!.calls;
  return { stores, runtime, rows };
}

describe('行动来源与恢复观测', () => {
  it('复核通过仍采用生成调用；重做才采用修订调用', async () => {
    const accepted = await fixture();
    const first = await runActionGraph(
      accepted.runtime(['2', '{"accept":true,"issues":""}']),
      request,
    );
    const firstRows = await accepted.rows();
    expect(first.snapshot.sourceCallId).toBe(firstRows[0].callId);
    expect(first.snapshot.sourceCallId).not.toBe(firstRows[1].callId);
    const revised = await fixture();
    const result = await runActionGraph(
      revised.runtime(['2', '{"accept":false,"issues":"重做"}', '3']),
      request,
    );
    const calls = await revised.rows();
    expect(result.snapshot.sourceCallId).toBe(calls[2].callId);
    expect(calls.map((row) => row.step)).toEqual(['generate', 'critique', 'revise']);
    expect(calls.map((row) => row.status)).toEqual(['accepted', 'accepted', 'accepted']);
  });

  it('检查点恢复只重跑失败节点；任务编号复用而执行与调用编号更新', async () => {
    const { runtime, stores, rows } = await fixture();
    const saver = stores.checkpoints;
    await expect(
      runActionGraph(runtime(['2', new Error('中断')]), request, { saver }),
    ).rejects.toThrow('中断');
    const before = await rows();
    expect(before).toHaveLength(2);
    const outcome = await runActionGraph(runtime(['{"accept":true,"issues":""}']), request, {
      saver,
      resume: true,
    });
    const after = await rows();
    expect(after).toHaveLength(3);
    expect(outcome.snapshot.sourceCallId).toBe(before[0].callId);
    expect(after[2].taskId).toBe(before[1].taskId);
    expect(after[2].taskId).toBeTruthy();
    expect(after[2].executionId).not.toBe(before[1].executionId);
    expect(after[2].callId).not.toBe(before[1].callId);
    expect(await runActionGraph(runtime([]), request, { saver, resume: true })).toEqual(outcome);
    expect(await rows()).toHaveLength(3);
  });

  it('同一节点的格式重问共享执行编号，每次调用各有编号', async () => {
    const { runtime, rows } = await fixture();
    const outcome = await runActionGraph(runtime(['"错值"', '2']), { ...request, preset: 'quick' });
    const calls = await rows();
    expect(calls.map((row) => row.formatAttempt)).toEqual([1, 2]);
    expect(calls[0].executionId).toBe(calls[1].executionId);
    expect(calls[0].callId).not.toBe(calls[1].callId);
    expect(outcome.snapshot.sourceCallId).toBe(calls[1].callId);
  });
});
