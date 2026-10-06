import { LOCAL_PROMPTS } from '../prompts/catalog';
import { ACTION_TYPES } from '@werewolf/shared';
import { z } from 'zod';
import { phaseInstanceId } from '../core/identity';
import { recordingModelPort } from '../llm/recording-model-port';
import { openaiModelPort } from '../llm/openai-model-port';
import { ModelCallError, type ModelPort } from '../llm/model-port';
import { scriptedModel, type ScriptedStep } from '../testing/model';
import { stubSkills } from '../testing/fixtures';
import { memoryStores } from '../store/memory';
import { runActionGraph } from './graph';
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
  const runtime = (answers: ScriptedStep[] | ModelPort): TurnRuntime => ({
    asked: stores.asked,
    port: recordingModelPort(Array.isArray(answers) ? scriptedModel(answers) : answers, (asked) =>
      stores.asked.append('g', { ...asked, actionKey: actionKeyOf(request) }),
    ),
    accessFor: () => ({
      model: 'test',
      baseUrl: 'http://test.invalid',
      apiKey: 'secret',
      capability: { reasoningOff: null },
    }),
    memoriesFor: () => [],
    promptSource: LOCAL_PROMPTS,
    skills: stubSkills(),
  });
  const rows = async () => (await stores.observations.read('g'))!.calls;
  return { stores, runtime, rows };
}

function observedModel(answers: string[]) {
  let index = 0;
  const send = jest.fn(async () => {
    const answer = answers[index++];
    if (answer === undefined) throw new Error('不应重新调用已经答复的模型');
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [{ function: { name: 'submit', arguments: `{"value":${answer}}` } }],
            },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  return { port: openaiModelPort({ fetch: send }), send };
}

function failObservation(
  stores: Awaited<ReturnType<typeof fixture>>['stores'],
  step: string,
  write: 'finishAttempt' | 'finish',
  formatAttempt = 1,
) {
  const failure = new Error('模拟观测写入失败');
  const append = stores.asked.append.bind(stores.asked);
  let injected = false;
  jest.spyOn(stores.asked, 'append').mockImplementation(async (...args) => {
    const recording = (await append(...args))!;
    const identity = args[1].observation;
    if (injected || identity?.step !== step || identity.formatAttempt !== formatAttempt)
      return recording;
    injected = true;
    return {
      ...recording,
      [write]: async () => {
        throw failure;
      },
    };
  });
  return failure;
}

describe('行动来源与恢复观测', () => {
  it.each(['started', 'accepted'] as const)(
    '进程中断丢失答复检查点后，%s 原调用阻止恢复时重新采样',
    async (status) => {
      const f = await fixture();
      const saver = f.stores.checkpoints;
      const quick = { ...request, preset: 'quick' as const };
      const interrupted = new Error('模拟进程在检查点持久化前中断');
      const append = f.stores.asked.append.bind(f.stores.asked);
      jest.spyOn(f.stores.asked, 'append').mockImplementationOnce(async (...args) => {
        const recording = (await append(...args))!;
        return {
          ...recording,
          async finish(result) {
            if (status === 'accepted') await recording.finish(result);
            throw interrupted;
          },
        };
      });
      const write = saver.putWrites.bind(saver);
      jest.spyOn(saver, 'putWrites').mockImplementation(async (config, writes, taskId) => {
        const retained = writes.filter(
          ([channel, value]) =>
            channel !== '__return__' ||
            value === null ||
            typeof value !== 'object' ||
            !('callId' in value),
        );
        if (retained.length) await write(config, retained, taskId);
      });
      const first = observedModel(['2']);
      await expect(runActionGraph(f.runtime(first.port), quick, { saver })).rejects.toMatchObject({
        cause: interrupted,
      });
      const before = await f.rows();
      expect(before).toHaveLength(1);
      expect(before[0].status).toBe(status);
      const resumed = observedModel(['2']);
      await expect(
        runActionGraph(f.runtime(resumed.port), quick, { saver, resume: true }),
      ).rejects.toThrow(before[0].callId!);
      expect(resumed.send).not.toHaveBeenCalled();
      expect(await f.rows()).toEqual(before);
    },
  );

  it('请求未收尾且派发标记缺失时，恢复不把未知当成未发送', async () => {
    const f = await fixture();
    const saver = f.stores.checkpoints;
    const quick = { ...request, preset: 'quick' as const };
    const interrupted = new Error('模拟进程在请求期间中断');
    const append = f.stores.asked.append.bind(f.stores.asked);
    jest.spyOn(f.stores.asked, 'append').mockImplementationOnce(async (...args) => ({
      ...(await append(...args))!,
      finish: async () => {},
    }));
    const first: ModelPort = {
      async generate(_request, _access, call) {
        await call!.startAttempt!();
        throw interrupted;
      },
    };
    await expect(runActionGraph(f.runtime(first), quick, { saver })).rejects.toBe(interrupted);
    const before = await f.rows();
    expect(before[0]).toMatchObject({
      status: 'started',
      attempts: [{ status: 'started', dispatched: null }],
    });
    const resumed = observedModel(['2']);
    await expect(
      runActionGraph(f.runtime(resumed.port), quick, { saver, resume: true }),
    ).rejects.toThrow(before[0].callId!);
    expect(resumed.send).not.toHaveBeenCalled();
    expect(await f.rows()).toEqual(before);
  });

  it.each([
    { status: 'failed' as const, failureCode: 'transient', dispatched: true },
    { status: 'cancelled' as const, failureCode: 'deadline', dispatched: true },
    { status: 'failed' as const, failureCode: 'internal', dispatched: false },
  ])('请求已经明确 $status/$failureCode 时，恢复补完旧调用后可以重试', async (completion) => {
    const f = await fixture();
    const saver = f.stores.checkpoints;
    const quick = { ...request, preset: 'quick' as const };
    const interrupted = new Error('模拟请求已收尾但逻辑调用未收尾时中断');
    const append = f.stores.asked.append.bind(f.stores.asked);
    jest.spyOn(f.stores.asked, 'append').mockImplementationOnce(async (...args) => ({
      ...(await append(...args))!,
      finish: async () => {},
    }));
    const first: ModelPort = {
      async generate(_request, _access, call) {
        const attempt = await call!.startAttempt!();
        await attempt.finish({
          ...completion,
          durationMs: 2,
          thinkingMs: null,
          httpStatus: null,
          requestId: null,
          usage: null,
          usageComplete: false,
        });
        throw interrupted;
      },
    };
    await expect(runActionGraph(f.runtime(first), quick, { saver })).rejects.toBe(interrupted);
    const before = await f.rows();
    expect(before[0].status).toBe('started');
    const resumed = observedModel(['2']);
    await expect(
      runActionGraph(f.runtime(resumed.port), quick, { saver, resume: true }),
    ).resolves.toMatchObject({ decision: 2 });
    expect(resumed.send).toHaveBeenCalledTimes(1);
    const after = await f.rows();
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({
      callId: before[0].callId,
      status: completion.status,
      failureCode: completion.failureCode,
      durationMs: null,
      finishedAt: before[0].attempts[0].finishedAt,
    });
  });

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

  it.each(
    ['generate', 'critique', 'revise'].flatMap((step, index) =>
      (['finishAttempt', 'finish'] as const).map((write) => ({ step, index, write })),
    ),
  )('$step 的 $write 失败后复用答复，补写失败也不重发', async ({ step, index, write }) => {
    const f = await fixture();
    const failure = failObservation(f.stores, step, write);
    const answers = ['2', '{"accept":false,"issues":"重做"}', '3'];
    const first = observedModel(answers.slice(0, index + 1));
    const saver = f.stores.checkpoints;
    await expect(runActionGraph(f.runtime(first.port), request, { saver })).rejects.toMatchObject({
      cause: failure,
    });
    const before = await f.rows();
    expect(first.send).toHaveBeenCalledTimes(index + 1);
    const recovery = write === 'finishAttempt' ? 'finishAttempt' : 'finishCall';
    jest.spyOn(f.stores.asked, recovery).mockRejectedValueOnce(failure);
    const blocked = observedModel([]);
    await expect(
      runActionGraph(f.runtime(blocked.port), request, { saver, resume: true }),
    ).rejects.toBe(failure);
    expect(blocked.send).not.toHaveBeenCalled();
    const resumed = observedModel(answers.slice(index + 1));
    const outcome = await runActionGraph(f.runtime(resumed.port), request, { saver, resume: true });
    const after = await f.rows();
    expect(resumed.send).toHaveBeenCalledTimes(2 - index);
    expect(after).toHaveLength(3);
    expect(after.slice(0, before.length).map((row) => row.callId)).toEqual(
      before.map((row) => row.callId),
    );
    expect(outcome.decision).toBe(3);
    expect(outcome.snapshot.sourceCallId).toBe(after[2].callId);
    expect(after.map((row) => row.step)).toEqual(['generate', 'critique', 'revise']);
    for (const row of after)
      expect(row).toMatchObject({
        status: 'accepted',
        attempts: [
          {
            status: 'succeeded',
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            usageComplete: true,
          },
        ],
      });
  });

  it.each(
    [1, 2].flatMap((formatAttempt) =>
      (['finishAttempt', 'finish'] as const).map((write) => ({ formatAttempt, write })),
    ),
  )(
    '第 $formatAttempt 次格式答复的 $write 失败后不重复已完成采样',
    async ({ formatAttempt, write }) => {
      const f = await fixture();
      const failure = failObservation(f.stores, 'generate', write, formatAttempt);
      const answers = ['"错值"', '2'];
      const first = observedModel(answers.slice(0, formatAttempt));
      const saver = f.stores.checkpoints;
      const quick = { ...request, preset: 'quick' as const };
      await expect(runActionGraph(f.runtime(first.port), quick, { saver })).rejects.toMatchObject({
        cause: failure,
      });
      const before = await f.rows();
      const resumed = observedModel(answers.slice(formatAttempt));
      const outcome = await runActionGraph(f.runtime(resumed.port), quick, { saver, resume: true });
      const after = await f.rows();
      expect(first.send).toHaveBeenCalledTimes(formatAttempt);
      expect(resumed.send).toHaveBeenCalledTimes(2 - formatAttempt);
      expect(after).toHaveLength(2);
      expect(after.slice(0, before.length).map((row) => row.callId)).toEqual(
        before.map((row) => row.callId),
      );
      expect(after.map((row) => row.status)).toEqual(['invalid_output', 'accepted']);
      expect(after.map((row) => row.formatAttempt)).toEqual([1, 2]);
      expect(after.every((row) => row.attempts[0]?.usage?.total_tokens === 5)).toBe(true);
      expect(outcome.decision).toBe(2);
      expect(outcome.snapshot.sourceCallId).toBe(after[1].callId);
    },
  );

  it.each([
    { known: true, label: '明确失败' },
    { known: false, label: '结果未知' },
  ])('未收到答复且调用收尾失败时，$label 恢复后仍按原状态处理', async ({ known }) => {
    const f = await fixture();
    const failure = failObservation(f.stores, 'generate', 'finish');
    const port: ModelPort = {
      async generate(_request, _access, call) {
        const attempt = await call!.startAttempt!();
        attempt.dispatched();
        if (known) {
          await attempt.finish({
            status: 'failed',
            dispatched: true,
            failureCode: 'transient',
            durationMs: 1,
            thinkingMs: null,
            httpStatus: 503,
            requestId: null,
            usage: null,
            usageComplete: false,
          });
          throw new ModelCallError('transient', '模拟服务不可用');
        }
        throw new Error('请求结果未知');
      },
    };
    const saver = f.stores.checkpoints;
    const quick = { ...request, preset: 'quick' as const };
    await expect(runActionGraph(f.runtime(port), quick, { saver })).rejects.toMatchObject({
      cause: failure,
    });
    const before = await f.rows();
    const resumed = observedModel(['2']);
    const result = runActionGraph(f.runtime(resumed.port), quick, { saver, resume: true });
    if (known) {
      await expect(result).resolves.toMatchObject({ decision: 2 });
      expect(resumed.send).toHaveBeenCalledTimes(1);
    } else {
      await expect(result).rejects.toThrow('结果未知');
      expect(resumed.send).not.toHaveBeenCalled();
    }
    const after = await f.rows();
    expect(after).toHaveLength(known ? 2 : 1);
    expect(after[0]).toMatchObject({
      callId: before[0].callId,
      status: 'failed',
      failureCode: known ? 'transient' : 'internal',
    });
  });

  it('格式预算耗尽后人工续跑只新增一轮采样，完成后继续复用结果', async () => {
    const f = await fixture();
    const saver = f.stores.checkpoints;
    const quick = { ...request, preset: 'quick' as const };
    const first = observedModel(['"错值"', '"错值"', '"错值"']);
    await expect(runActionGraph(f.runtime(first.port), quick, { saver })).rejects.toMatchObject({
      code: 'invalid_output',
    });
    expect(first.send).toHaveBeenCalledTimes(3);
    const before = await f.rows();
    expect(before.map((row) => row.status)).toEqual([
      'invalid_output',
      'invalid_output',
      'invalid_output',
    ]);
    const resumed = observedModel(['2']);
    const outcome = await runActionGraph(f.runtime(resumed.port), quick, { saver, resume: true });
    expect(outcome.decision).toBe(2);
    expect(resumed.send).toHaveBeenCalledTimes(1);
    const after = await f.rows();
    expect(after).toHaveLength(4);
    expect(after.slice(0, 3).map((row) => row.callId)).toEqual(before.map((row) => row.callId));
    expect(after[3].status).toBe('accepted');
    expect(outcome.snapshot.sourceCallId).toBe(after[3].callId);
    const completed = observedModel([]);
    await expect(
      runActionGraph(f.runtime(completed.port), quick, { saver, resume: true }),
    ).resolves.toEqual(outcome);
    expect(completed.send).not.toHaveBeenCalled();
    expect(await f.rows()).toHaveLength(4);
  });
});
