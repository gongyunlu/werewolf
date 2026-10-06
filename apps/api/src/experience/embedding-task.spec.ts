import { ModelCallError } from '../llm/model-port';
import { openaiModelPort } from '../llm/openai-model-port';
import { memoryStores } from '../store/memory';
import { embedTask, newEmbeddingTask } from './embedding-task';
import { vectorRuntime } from './testing';

async function setup() {
  const stores = memoryStores();
  const scope = { gameId: 'embedding-recovery', actionKey: null, summaryKey: 'experience/test' };
  await stores.games.open({ gameId: scope.gameId, boardId: '6p_white_wolf', roster: [] });
  const runtime = vectorRuntime();
  let task = newEmbeddingTask('离线经验', runtime);
  const run = () =>
    embedTask(stores, scope, task, runtime, async (next) => {
      task = next;
    });
  const observation = async () => (await stores.observations.read(scope.gameId))!.calls;
  return { stores, runtime, run, task: () => task, observation };
}

describe('向量请求观测恢复', () => {
  it('发送前写调用记录失败后可恢复，首次失败不发送模型请求', async () => {
    const f = await setup();
    jest.spyOn(f.stores.asked, 'append').mockRejectedValueOnce(new Error('模拟写入失败'));
    await expect(f.run()).rejects.toThrow();
    expect(f.runtime.port.generate).not.toHaveBeenCalled();
    expect(f.task().attempts[0]!.status).toBe('failed');
    await expect(f.run()).resolves.toEqual([1, 0]);
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
  });

  it('收到向量后用量写入失败明确抛错，恢复补记用量且不重发模型', async () => {
    const f = await setup();
    const append = f.stores.asked.append.bind(f.stores.asked);
    jest.spyOn(f.stores.asked, 'append').mockImplementationOnce(async (...args) => ({
      ...(await append(...args))!,
      async finishAttempt() {
        throw new Error('模拟用量写入失败');
      },
    }));
    await expect(f.run()).rejects.toThrow('模型观测写入失败');
    expect(f.task().attempts[0]).toMatchObject({ status: 'responded', vector: [1, 0] });
    await expect(f.run()).resolves.toEqual([1, 0]);
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
    expect(await f.observation()).toMatchObject([
      {
        status: 'accepted',
        attempts: [{ status: 'succeeded', usage: { total_tokens: 8 }, usageComplete: true }],
      },
    ]);
  });

  it('明确请求失败的用量写入中断，先补记旧尝试再重试', async () => {
    const f = await setup();
    const append = f.stores.asked.append.bind(f.stores.asked);
    jest.spyOn(f.stores.asked, 'append').mockImplementationOnce(async (...args) => ({
      ...(await append(...args))!,
      async finishAttempt() {
        throw new Error('模拟失败结果写入中断');
      },
    }));
    jest.mocked(f.runtime.port.generate).mockImplementationOnce(async (_request, _access, call) => {
      const attempt = await call!.startAttempt!();
      attempt.dispatched();
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
    });
    await expect(f.run()).rejects.toThrow('模型观测写入失败');
    await expect(f.run()).resolves.toEqual([1, 0]);
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(2);
    expect(await f.observation()).toMatchObject([
      { status: 'failed', attempts: [{ status: 'failed', httpStatus: 503 }] },
      { status: 'accepted', attempts: [{ status: 'succeeded' }] },
    ]);
  });

  it('已知失败的调用收尾中断，先补收尾再重试，补写失败不重发', async () => {
    const f = await setup();
    const failure = new Error('模拟调用收尾写入失败');
    const append = f.stores.asked.append.bind(f.stores.asked);
    jest.spyOn(f.stores.asked, 'append').mockImplementationOnce(async (...args) => ({
      ...(await append(...args))!,
      async finish() {
        throw failure;
      },
    }));
    jest.mocked(f.runtime.port.generate).mockImplementationOnce(async (_request, _access, call) => {
      const attempt = await call!.startAttempt!();
      attempt.dispatched();
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
    });
    await expect(f.run()).rejects.toMatchObject({ cause: failure });
    expect(f.task().attempts[0]).toMatchObject({
      status: 'failed',
      observation: { call: { status: 'failed', failureCode: 'transient' } },
    });
    expect(await f.observation()).toMatchObject([
      { status: 'started', attempts: [{ status: 'failed', httpStatus: 503 }] },
    ]);
    const completion = f.task().attempts[0]!.observation;
    jest.spyOn(f.stores.asked, 'finishCall').mockRejectedValueOnce(failure);
    await expect(f.run()).rejects.toBe(failure);
    expect(f.task().attempts[0]!.observation).toEqual(completion);
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
    await expect(f.run()).resolves.toEqual([1, 0]);
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(2);
    expect(f.task().attempts[0]!.observation).toBeUndefined();
    expect(await f.observation()).toMatchObject([
      { status: 'failed', attempts: [{ status: 'failed', httpStatus: 503 }] },
      { status: 'accepted', attempts: [{ status: 'succeeded' }] },
    ]);
  });

  it('未知请求错误的调用收尾中断，补写后仍不能自动重发', async () => {
    const f = await setup();
    const append = f.stores.asked.append.bind(f.stores.asked);
    jest.spyOn(f.stores.asked, 'append').mockImplementationOnce(async (...args) => ({
      ...(await append(...args))!,
      async finish() {
        throw new Error('模拟调用收尾写入失败');
      },
    }));
    jest.mocked(f.runtime.port.generate).mockImplementationOnce(async (_request, _access, call) => {
      const attempt = await call!.startAttempt!();
      attempt.dispatched();
      throw new Error('请求结果未知');
    });
    await expect(f.run()).rejects.toThrow('模型观测写入失败');
    expect(f.task().attempts[0]!.status).toBe('pending');
    await expect(f.run()).rejects.toThrow('上次向量请求结果未知');
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    '未知异常且请求观测写入失败时按实际派发状态恢复：%s',
    async (dispatched) => {
      const f = await setup();
      const failure = new Error('模拟请求观测写入失败');
      const append = f.stores.asked.append.bind(f.stores.asked);
      jest.spyOn(f.stores.asked, 'append').mockImplementationOnce(async (...args) => ({
        ...(await append(...args))!,
        async finishAttempt() {
          throw failure;
        },
      }));
      const send = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: dispatched ? null : [{ index: 0, embedding: [1, 0] }],
              usage: { prompt_tokens: 8, total_tokens: 8 },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      );
      f.runtime.port = openaiModelPort({ fetch: send });
      // 非 ASCII 请求头会在 fetch 前失败；空 data 则在收到响应后触发未知异常。
      f.runtime.access = { ...f.runtime.access, apiKey: dispatched ? 'offline' : '测试' };
      await expect(f.run()).rejects.toMatchObject({ cause: failure });
      expect(f.task().attempts[0]).toMatchObject({
        status: dispatched ? 'pending' : 'failed',
        observation: { result: { status: 'failed', failureCode: 'internal', dispatched } },
      });
      expect(send).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      f.runtime.access = { ...f.runtime.access, apiKey: 'offline' };
      if (dispatched) await expect(f.run()).rejects.toThrow('上次向量请求结果未知');
      else await expect(f.run()).resolves.toEqual([1, 0]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(f.task().attempts).toHaveLength(dispatched ? 1 : 2);
      expect(f.task().attempts[0]!.observation).toBeUndefined();
    },
  );
});
