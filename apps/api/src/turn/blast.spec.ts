import { ROLES } from '@werewolf/shared';
import {
  ModelCallError,
  type ModelCallOptions,
  type ModelPort,
  type ModelRequest,
} from '../llm/model-port';
import { memoryStores } from '../store/memory';
import { runBlastWindow } from '../core/day/self-destruct';
import { retryingModelPort } from '../llm/retrying-model-port';
import type { CallCompletion } from '../llm/observation';
import { makeState, stubSkills, withRoles } from '../testing/fixtures';
import { responseOf } from '../testing/model';
import { LOCAL_TURN_PROMPTS } from './prompt';
import { modelActions } from './provider';
import type { TurnRuntime } from './request';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 可逐个放行响应和记账，不依赖计时长短安排谁先回答。 */
async function setup(honorAbort = true) {
  const state = withRoles(makeState(6), { p1: ROLES.WEREWOLF, p2: ROLES.WEREWOLF, p3: ROLES.SEER });
  const stores = memoryStores();
  await stores.games.open({ gameId: state.gameId, boardId: '12p_wolf_king', roster: [] });
  const calls: {
    seat: number;
    call: ModelCallOptions;
    request: ModelRequest;
    answer: ReturnType<typeof deferred<string>>;
    received: ReturnType<typeof deferred<void>>;
    writing?: Promise<void>;
  }[] = [];
  const port: ModelPort = {
    async generate(request, access, call = {}) {
      const item = {
        seat: Number(access.model),
        request,
        call,
        answer: deferred<string>(),
        received: deferred<void>(),
      };
      calls.push(item);
      const attempt = await call.startAttempt?.();
      attempt?.dispatched();
      const abort = () => item.answer.reject(new ModelCallError('deadline', '请求已中止'));
      if (honorAbort) call.signal?.addEventListener('abort', abort, { once: true });
      let value: string;
      try {
        value = await item.answer.promise;
      } catch (error) {
        await attempt?.finish({
          status: 'cancelled',
          failureCode: 'deadline',
          dispatched: true,
          durationMs: 7,
          httpStatus: 200,
          requestId: null,
          usage: { prompt_tokens: 9 },
          usageComplete: false,
          thinkingMs: null,
        });
        throw error;
      } finally {
        call.signal?.removeEventListener('abort', abort);
      }
      const response = responseOf(request, value);
      call.onResponse?.(response);
      item.received.resolve();
      await (item as (typeof calls)[number]).writing;
      await attempt?.finish({
        status: 'succeeded',
        failureCode: null,
        dispatched: true,
        durationMs: 11,
        httpStatus: 200,
        requestId: null,
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        usageComplete: true,
        thinkingMs: null,
      });
      return response;
    },
  };
  const runtime: TurnRuntime = {
    port,
    accessFor: (seat) => ({
      baseUrl: 'https://model.example.test/v1',
      model: String(seat),
      apiKey: 'test',
      capability: { reasoningOff: null },
    }),
    memoriesFor: () => [],
    promptSource: LOCAL_TURN_PROMPTS,
    skills: stubSkills(),
  };
  function actions() {
    const result = modelActions(runtime, stores, state.phaseInstanceId);
    result.observe(state);
    return result;
  }
  async function started(count = 2) {
    for (let i = 0; i < 100 && calls.length < count; i++) await tick();
    expect(calls).toHaveLength(count);
    return calls;
  }
  return { state, stores, runtime, calls, actions, started };
}

describe('自爆竞速与持久化', () => {
  it('后排先有效回答，记账落后也仍是赢家；已完成败方保留真实成功记录', async () => {
    const h = await setup(false);
    const running = h.actions().chooseBlaster(['p1', 'p2'], 'day');
    const calls = await h.started();
    const slowWrite = deferred<void>();
    calls[1].writing = slowWrite.promise;
    calls[1].answer.resolve('true');
    await calls[1].received.promise;
    expect(calls[0].call.signal?.aborted).toBe(true);
    expect(calls[1].call.signal?.aborted).toBe(false);
    calls[0].answer.resolve('true');
    await calls[0].received.promise;
    await tick();
    slowWrite.resolve();
    await expect(running).resolves.toBe('p2');
    const rows = await h.stores.observations.read(h.state.gameId);
    expect(rows!.calls.map((call) => call.status)).toEqual(['accepted', 'accepted']);
    expect(rows!.calls.flatMap((call) => call.attempts)).toHaveLength(2);
    const replay = h.actions();
    await expect(replay.chooseBlaster(['p1', 'p2'], 'day')).resolves.toBe('p2');
    expect(h.calls).toHaveLength(2);
    expect(replay.outcomes()).toHaveLength(2);
  });

  it('取消尚未完成的败方，保留部分用量和请求次数', async () => {
    const h = await setup();
    const running = h.actions().chooseBlaster(['p1', 'p2'], 'day');
    const calls = await h.started();
    calls[1].answer.resolve('true');
    await expect(running).resolves.toBe('p2');
    const rows = await h.stores.observations.read(h.state.gameId);
    expect(rows!.calls[0]).toMatchObject({ status: 'cancelled' });
    expect(rows!.calls[0].attempts).toHaveLength(1);
    expect(rows!.calls[0].attempts[0]).toMatchObject({ status: 'cancelled', usageComplete: false });
    await expect(h.actions().chooseBlaster(['p1', 'p2'], 'day')).resolves.toBe('p2');
    expect(h.calls).toHaveLength(2);
  });

  it('false 不抢占，全部 false 的裁决可恢复，下一窗口使用新的行动序号', async () => {
    const h = await setup();
    const running = h.actions().chooseBlaster(['p1', 'p2'], 'campaign');
    const calls = await h.started();
    calls[0].answer.resolve('false');
    await calls[0].received.promise;
    expect(calls[1].call.signal?.aborted).toBe(false);
    calls[1].answer.resolve('false');
    await expect(running).resolves.toBeNull();
    const replay = h.actions();
    await expect(replay.chooseBlaster(['p1', 'p2'], 'campaign')).resolves.toBeNull();
    expect(h.calls).toHaveLength(2);
    const next = replay.chooseBlaster(['p1', 'p2'], 'campaign_pk');
    await h.started(4);
    h.calls[3].answer.resolve('true');
    await expect(next).resolves.toBe('p2');
    const actions = await h.stores.actions.list(h.state.gameId);
    expect(actions.map((action) => action.actionOrdinal)).toEqual([0, 0, 1, 1]);
  });

  it('无效格式不能抢占，已发出的格式重问会被赢家取消', async () => {
    const h = await setup();
    const running = h.actions().chooseBlaster(['p1', 'p2'], 'day');
    const calls = await h.started();
    calls[0].answer.resolve('"要自爆"');
    await h.started(3);
    calls[1].answer.resolve('true');
    await expect(running).resolves.toBe('p2');
    expect(calls[2].call.signal?.aborted).toBe(true);
    const rows = await h.stores.observations.read(h.state.gameId);
    expect(rows!.calls.map((call) => call.status)).toEqual([
      'invalid_output',
      'accepted',
      'cancelled',
    ]);
  });

  it('赢家提交失败后恢复原裁决并补完行动，不重问赢家或败方', async () => {
    const h = await setup();
    const finish = jest
      .spyOn(h.stores.actions, 'finish')
      .mockRejectedValueOnce(new Error('行动提交失败'));
    const running = h.actions().chooseBlaster(['p1', 'p2'], 'day');
    const failed = expect(running).rejects.toThrow('行动提交失败');
    const calls = await h.started();
    calls[1].answer.resolve('true');
    await failed;
    finish.mockRestore();
    await expect(h.actions().chooseBlaster(['p1', 'p2'], 'day')).resolves.toBe('p2');
    expect(h.calls).toHaveLength(2);
    expect(
      (await h.stores.actions.list(h.state.gameId)).find((action) => action.actorId === 'p2'),
    ).toMatchObject({ status: 'done', outcome: { decision: true } });
  });

  it('生成检查点之前记账失败，也可用已保存的有效答案补完赢家', async () => {
    const h = await setup();
    let completion: CallCompletion | undefined;
    const append = h.stores.asked.append.bind(h.stores.asked);
    h.stores.asked.append = async (game, asked) => {
      const recording = await append(game, asked);
      if (!recording) return;
      return {
        ...recording,
        async finish(result) {
          if (result.status === 'accepted') {
            completion = result;
            throw new Error('逻辑调用收尾写入失败');
          }
          await recording.finish(result);
        },
      };
    };
    const running = h.actions().chooseBlaster(['p1', 'p2'], 'day');
    const failed = expect(running).rejects.toThrow('模型观测写入失败');
    const calls = await h.started();
    calls[1].answer.resolve('true');
    await failed;
    h.stores.asked.append = append;
    const replay = h.actions();
    await expect(replay.chooseBlaster(['p1', 'p2'], 'day')).resolves.toBe('p2');
    expect(h.calls).toHaveLength(2);
    expect(replay.outcomes()[0].snapshot.sourceCallId).toBe(calls[1].call.identity!.callId);
    const rows = await h.stores.observations.read(h.state.gameId);
    const winner = rows!.calls.find((call) => call.callId === calls[1].call.identity!.callId)!;
    expect(winner).toMatchObject({
      ...completion,
      status: 'accepted',
    });
    expect(winner.attempts).toHaveLength(1);
    expect(winner.finishedAt).not.toBeNull();
    await expect(h.actions().chooseBlaster(['p1', 'p2'], 'day')).resolves.toBe('p2');
    const again = await h.stores.observations.read(h.state.gameId);
    expect(again!.calls.find((call) => call.callId === winner.callId)).toEqual(winner);
    expect(h.calls).toHaveLength(2);
  });

  it('没有赢家时模型失败必须抛出，不能算成无人自爆', async () => {
    const h = await setup();
    const running = h.actions().chooseBlaster(['p1', 'p2'], 'day');
    const failed = expect(running).rejects.toThrow('调用失败');
    const calls = await h.started();
    calls[0].answer.reject(new ModelCallError('fatal', '调用失败'));
    calls[1].answer.resolve('false');
    await failed;
  });

  it('首个 false 不抢占，后一个 true 仍生效', async () => {
    const h = await setup();
    const running = h.actions().chooseBlaster(['p1', 'p2'], 'day');
    const calls = await h.started();
    calls[0].answer.resolve('false');
    await calls[0].received.promise;
    expect(calls[1].call.signal?.aborted).toBe(false);
    calls[1].answer.resolve('true');
    await expect(running).resolves.toBe('p2');
  });

  it('赢家产生时另一行动尚未发请求，放行后也不会新增模型调用', async () => {
    const h = await setup();
    const hold = deferred<void>();
    const begin = h.stores.actions.begin.bind(h.stores.actions);
    h.stores.actions.begin = async (intent) => {
      if (intent.actorId === 'p1') await hold.promise;
      return begin(intent);
    };
    const running = h.actions().chooseBlaster(['p1', 'p2'], 'day');
    const calls = await h.started(1);
    calls[0].answer.resolve('true');
    await calls[0].received.promise;
    hold.resolve();
    await expect(running).resolves.toBe('p2');
    expect(h.calls).toHaveLength(1);
  });

  it('传输退避中收到取消，不再发送下一次请求', async () => {
    const h = await setup();
    h.runtime.port = retryingModelPort(h.runtime.port, { backoffMs: 60_000 });
    const running = h.actions().chooseBlaster(['p1', 'p2'], 'day');
    const calls = await h.started();
    calls[0].answer.reject(new ModelCallError('transient', '暂时失败'));
    await tick();
    calls[1].answer.resolve('true');
    await expect(running).resolves.toBe('p2');
    expect(h.calls).toHaveLength(2);
  });

  it('败方本地存储出错必须暴露，不按模型取消吞掉', async () => {
    const h = await setup(false);
    const finish = h.stores.actions.finish.bind(h.stores.actions);
    h.stores.actions.finish = async (key, outcome) => {
      if (JSON.parse(key).includes('p1')) throw new Error('败方写入失败');
      return finish(key, outcome);
    };
    const running = h.actions().chooseBlaster(['p1', 'p2'], 'day');
    const failed = expect(running).rejects.toThrow('败方写入失败');
    const calls = await h.started();
    calls[1].answer.resolve('true');
    await calls[1].received.promise;
    calls[0].answer.resolve('true');
    await failed;
  });

  it('赢家请求记账失败不能被前排败方的取消错误掩盖', async () => {
    const h = await setup();
    const writing = deferred<void>();
    const running = h.actions().chooseBlaster(['p1', 'p2'], 'day');
    const failed = expect(running).rejects.toThrow('赢家请求记账失败');
    const calls = await h.started();
    calls[1].writing = writing.promise;
    calls[1].answer.resolve('true');
    await calls[1].received.promise;
    writing.reject(new Error('赢家请求记账失败'));
    await failed;
  });

  it('白狼王带人时中断，恢复仍结算原赢家且不重问任何狼的自爆决定', async () => {
    const h = await setup();
    const initial = withRoles(h.state, { p2: ROLES.WHITE_WOLF });
    const actions = h.actions();
    actions.observe(initial);
    const running = runBlastWindow(initial, 'day', actions, actions.observe, actions.recordFlow);
    const failed = expect(running).rejects.toThrow('带人时中断');
    const calls = await h.started();
    calls[1].answer.resolve('true');
    await h.started(3);
    calls[2].answer.reject(new Error('带人时中断'));
    await failed;
    const replay = h.actions();
    replay.observe(initial);
    const resumed = runBlastWindow(initial, 'day', replay, replay.observe, replay.recordFlow);
    await h.started(4);
    calls[3].answer.resolve('null');
    await h.started(5);
    calls[4].answer.resolve('{"accept":true,"issues":""}');
    const result = await resumed;
    expect(result.state.players.find((player) => player.id === 'p2')?.isAlive).toBe(false);
    expect(result.state.players.find((player) => player.id === 'p1')?.isAlive).toBe(true);
    expect(calls.filter((call) => call.request.prompt.includes('决定是否自爆'))).toHaveLength(2);
    const events = await h.stores.events.list(initial.gameId);
    expect(events.filter((event) => event.text.includes('2 号自爆出局'))).toHaveLength(1);
  });
});
