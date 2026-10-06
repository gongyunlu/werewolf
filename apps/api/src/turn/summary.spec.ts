import { LOCAL_PROMPTS } from '../prompts/catalog';
import type { ModelCapability } from '../llm/model-capability';
import type { ModelAccess, ModelPort } from '../llm/model-port';
import { openaiModelPort } from '../llm/openai-model-port';
import { recordingModelPort } from '../llm/recording-model-port';
import { memoryStores } from '../store/memory';
import { stubSkills } from '../testing/fixtures';
import { scriptedModel } from '../testing/model';
import { summarize } from './summary';
import type { TurnRuntime } from './request';

const CAPABILITY: ModelCapability = { reasoningOff: null };

const ACCESS: ModelAccess = {
  baseUrl: 'https://model.example.test/v1',
  model: '用例模型',
  apiKey: 'sk-不能进快照',
  capability: CAPABILITY,
};

/** 两个人的一天：3 号与 5 号各说过一次。 */
const SPEECHES = [
  { seatNo: 3, lines: ['3 号发言：我先过。'] },
  { seatNo: 5, lines: ['5 号发言：我跟 3 号。'] },
];

function runtimeWith(answers: readonly (string | Error)[]) {
  const model = scriptedModel(answers);

  return {
    model,
    runtime: {
      port: model,
      accessFor: () => ACCESS,
      memoriesFor: () => [],
      promptSource: LOCAL_PROMPTS,
      skills: stubSkills(),
    } satisfies TurnRuntime,
  };
}

function itemsOf(...pairs: readonly (readonly [number, string])[]): string {
  return JSON.stringify({ items: pairs.map(([seatNo, gist]) => ({ seatNo, gist })) });
}

function fold(runtime: TurnRuntime) {
  return summarize(runtime, { day: 1, channel: '公开发言', speeches: SPEECHES });
}

describe('折摘要', () => {
  it.each([false, true])(
    '请求中断且没有答复检查点时，恢复摘要保留原调用（旧记录：%s）',
    async (legacy) => {
      const stores = memoryStores();
      const gameId = 'summary-interrupted';
      await stores.games.open({ gameId, boardId: 'test', roster: [] });
      const append = stores.asked.append.bind(stores.asked);
      jest.spyOn(stores.asked, 'append').mockImplementationOnce(async (...args) => ({
        ...(await append(args[0], {
          ...args[1],
          observation: {
            ...args[1].observation!,
            taskId: legacy ? undefined : args[1].observation!.taskId,
          },
        }))!,
        finish: async () => {},
      }));
      const runtime = (port: ModelPort, summaryKey = '1/public'): TurnRuntime => ({
        ...runtimeWith([]).runtime,
        asked: stores.asked,
        port: recordingModelPort(port, (asked) =>
          stores.asked.append(gameId, { ...asked, actionKey: null, summaryKey }),
        ),
      });
      const interrupted = new Error('模拟摘要请求期间进程中断');
      const first: ModelPort = {
        async generate(_request, _access, call) {
          await call!.startAttempt!();
          throw interrupted;
        },
      };
      const input = { day: 1, channel: '公开发言', speeches: SPEECHES };
      const recovery = {
        saver: stores.checkpoints,
        threadId: JSON.stringify([gameId, 'summary', '1/public']),
      };
      await expect(summarize(runtime(first), input, recovery)).rejects.toBe(interrupted);
      const before = (await stores.observations.read(gameId))!.calls;
      if (legacy) expect(before[0].taskId).toBeNull();
      else expect(before[0].taskId).toBeTruthy();
      expect(before[0]).toMatchObject({
        status: 'started',
        attempts: [{ status: 'started', dispatched: null }],
      });
      const resumed = scriptedModel([itemsOf([3, '说先过'], [5, '说跟 3 号'])]);
      await expect(summarize(runtime(resumed), input, recovery)).rejects.toThrow(before[0].callId!);
      expect(resumed.calls).toHaveLength(0);
      expect((await stores.observations.read(gameId))!.calls).toEqual(before);
      const wolf = scriptedModel([itemsOf([3, '狼队商议'], [5, '跟随队友'])]);
      await expect(
        summarize(
          runtime(wolf, '1/wolf'),
          { ...input, channel: '狼队商议' },
          {
            saver: stores.checkpoints,
            threadId: JSON.stringify([gameId, 'summary', '1/wolf']),
          },
        ),
      ).resolves.toHaveLength(2);
      expect(wolf.calls).toHaveLength(1);
    },
  );

  it('每人一条收齐了就照收，题面里带的是那一天的发言与要交几条', async () => {
    const { model, runtime } = runtimeWith([itemsOf([3, '说先过'], [5, '说跟 3 号'])]);

    const items = await fold(runtime);

    expect(items).toEqual([
      { seatNo: 3, gist: '说先过' },
      { seatNo: 5, gist: '说跟 3 号' },
    ]);

    const request = model.calls[0];
    expect(request.system).toContain('整理当天的发言纪要');
    expect(request.prompt).toContain('第 1 天，这一份是公开发言。');
    expect(request.prompt).toContain('3 号发言：我先过。');
    expect(request.prompt).toContain('5 号发言：我跟 3 号。');
    expect(request.prompt).toContain('一共要 2 条');
    // 形状由工具管：可选座位就是这一天说过话的那几个。
    expect(JSON.stringify(request.tool?.parameters)).toContain('[3,5]');
  });

  it('少一个人就判不合规，带上该有哪几个座位再问一次', async () => {
    const { model, runtime } = runtimeWith([
      itemsOf([3, '说先过']),
      itemsOf([3, '说先过'], [5, '说跟 3 号']),
    ]);

    const items = await fold(runtime);

    expect(items).toHaveLength(2);
    expect(model.calls).toHaveLength(2);

    // 再问的不是同一份题面：附回去的是交过的那份，和该收齐的那几个座位。
    const [first, second] = model.calls;
    expect(second.prompt.startsWith(first.prompt)).toBe(true);
    expect(second.prompt).toContain('3 号、5 号');
    // 诊断点到具体是谁：只说「条数不对」，它还是只能重掷。
    expect(second.prompt).toContain('少了 5 号的发言');
  });

  it('同一个人交两条也判不合规，问到第三次还不行就抛', async () => {
    const twice = itemsOf([3, '说先过'], [3, '又说了一遍']);
    const { model, runtime } = runtimeWith([twice, twice, twice]);

    await expect(fold(runtime)).rejects.toMatchObject({ code: 'invalid_output' });
    expect(model.calls).toHaveLength(3);
    // 交重了也要点名是谁，别让它以为是自己漏了。
    expect(model.calls[1].prompt).toContain('3 号交了两条');
  });

  it.each(['finishAttempt', 'finish'] as const)(
    '%s 失败后用新运行时恢复原摘要和观测',
    async (write) => {
      const stores = memoryStores();
      await stores.games.open({ gameId: 'summary-recovery', boardId: 'test', roster: [] });
      const failure = new Error('模拟摘要观测写入失败');
      const append = stores.asked.append.bind(stores.asked);
      jest.spyOn(stores.asked, 'append').mockImplementationOnce(async (...args) => ({
        ...(await append(...args))!,
        [write]: async () => {
          throw failure;
        },
      }));
      const send = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [
                      {
                        function: {
                          name: 'submit',
                          arguments: `{"value":${itemsOf([3, '说先过'], [5, '说跟 3 号'])}}`,
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      );
      const runtime = (port: ModelPort): TurnRuntime => ({
        ...runtimeWith([]).runtime,
        accessFor: () => ({ ...ACCESS, apiKey: 'offline' }),
        asked: stores.asked,
        port: recordingModelPort(port, (asked) =>
          stores.asked.append('summary-recovery', {
            ...asked,
            actionKey: null,
            summaryKey: '1/public',
          }),
        ),
      });
      const input = { day: 1, channel: '公开发言', speeches: SPEECHES };
      const recovery = {
        saver: stores.checkpoints,
        threadId: JSON.stringify(['summary-recovery', 'summary', '1/public']),
      };
      await expect(
        summarize(runtime(openaiModelPort({ fetch: send })), input, recovery),
      ).rejects.toMatchObject({ cause: failure });
      expect(send).toHaveBeenCalledTimes(1);
      const before = (await stores.observations.read('summary-recovery'))!.calls;
      jest
        .spyOn(stores.asked, write === 'finishAttempt' ? 'finishAttempt' : 'finishCall')
        .mockRejectedValueOnce(failure);
      const blocked = { generate: jest.fn().mockRejectedValue(new Error('不应重新询问摘要')) };
      await expect(summarize(runtime(blocked), input, recovery)).rejects.toBe(failure);
      expect(blocked.generate).not.toHaveBeenCalled();
      const resumed = { generate: jest.fn().mockRejectedValue(new Error('不应重新询问摘要')) };
      const expected = [
        { seatNo: 3, gist: '说先过' },
        { seatNo: 5, gist: '说跟 3 号' },
      ];
      await expect(summarize(runtime(resumed), input, recovery)).resolves.toEqual(expected);
      expect(resumed.generate).not.toHaveBeenCalled();
      const after = (await stores.observations.read('summary-recovery'))!.calls;
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        callId: before[0].callId,
        status: 'accepted',
        step: 'summary',
        attempts: [
          {
            status: 'succeeded',
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            usageComplete: true,
          },
        ],
      });
      await expect(summarize(runtime(resumed), input, recovery)).resolves.toEqual(expected);
      expect(resumed.generate).not.toHaveBeenCalled();
    },
  );

  it('格式预算耗尽后人工续跑只新增一轮摘要采样，完成后继续复用', async () => {
    const stores = memoryStores();
    await stores.games.open({ gameId: 'summary-format-recovery', boardId: 'test', roster: [] });
    const runtime = (model: ModelPort): TurnRuntime => ({
      ...runtimeWith([]).runtime,
      asked: stores.asked,
      port: recordingModelPort(model, (asked) =>
        stores.asked.append('summary-format-recovery', {
          ...asked,
          actionKey: null,
          summaryKey: '1/public',
        }),
      ),
    });
    const input = { day: 1, channel: '公开发言', speeches: SPEECHES };
    const recovery = {
      saver: stores.checkpoints,
      threadId: JSON.stringify(['summary-format-recovery', 'summary', '1/public']),
    };
    const incomplete = itemsOf([3, '说先过']);
    const first = scriptedModel([incomplete, incomplete, incomplete]);
    await expect(summarize(runtime(first), input, recovery)).rejects.toMatchObject({
      code: 'invalid_output',
    });
    expect(first.calls).toHaveLength(3);
    const before = (await stores.observations.read('summary-format-recovery'))!.calls;
    expect(before.map((row) => row.status)).toEqual([
      'invalid_output',
      'invalid_output',
      'invalid_output',
    ]);
    const resumed = scriptedModel([itemsOf([3, '说先过'], [5, '说跟 3 号'])]);
    const expected = [
      { seatNo: 3, gist: '说先过' },
      { seatNo: 5, gist: '说跟 3 号' },
    ];
    await expect(summarize(runtime(resumed), input, recovery)).resolves.toEqual(expected);
    expect(resumed.calls).toHaveLength(1);
    const after = (await stores.observations.read('summary-format-recovery'))!.calls;
    expect(after).toHaveLength(4);
    expect(after.slice(0, 3).map((row) => row.callId)).toEqual(before.map((row) => row.callId));
    expect(after[3].status).toBe('accepted');
    const completed = scriptedModel([]);
    await expect(summarize(runtime(completed), input, recovery)).resolves.toEqual(expected);
    expect(completed.calls).toHaveLength(0);
    expect((await stores.observations.read('summary-format-recovery'))!.calls).toHaveLength(4);
  });
});
