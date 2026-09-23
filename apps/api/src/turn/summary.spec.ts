import type { ModelCapability } from '../llm/model-capability';
import type { ModelAccess } from '../llm/model-port';
import { stubSkills } from '../testing/fixtures';
import { scriptedModel } from '../testing/model';
import { LOCAL_TURN_PROMPTS } from './prompt';
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
      promptSource: LOCAL_TURN_PROMPTS,
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
});
