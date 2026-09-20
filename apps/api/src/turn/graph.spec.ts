import { ACTION_TYPES } from '@werewolf/shared';
import { z } from 'zod';
import { actionKey, phaseInstanceId, type ActionScope } from '../core/identity';
import type { ModelCapability } from '../llm/model-capability';
import { ModelCallError, type ModelAccess } from '../llm/model-port';
import { scriptedModel } from '../testing/model';
import { runActionGraph } from './graph';
import { freezeTurnPrompts, TURN_PROMPT_NAMES, type FrozenPrompts } from './prompt';
import { actionOrdinals, type ActionRequest, type TurnContext, type TurnRuntime } from './request';

const CAPABILITY: ModelCapability = {
  protocol: 'jsonSchema',
  allowCodeFence: false,
  disableReasoning: true,
};

const ACCESS: ModelAccess = {
  baseUrl: 'https://model.example.test/v1',
  apiKey: 'sk-不能进快照',
  capability: CAPABILITY,
};

const SCOPE: ActionScope = { gameId: 'g1', phaseInstanceId: phaseInstanceId(3, 'vote') };

const DECISION_SCHEMA = z.object({ targetId: z.string().nullable(), reason: z.string() });

const CONTEXT: TurnContext = {
  task: '投票决定放逐谁。',
  actor: { playerId: 'p3', seatNo: 3, role: '预言家' },
  day: 2,
  visible: ['1 号昨天跳了预言家'],
  options: ['1 号 p1', '2 号 p2'],
};

const DECIDED = JSON.stringify({ targetId: 'p2', reason: '他发言太稳了' });
const REVISED = JSON.stringify({ targetId: 'p1', reason: '他才是最该出局的那个' });
const ACCEPTED = JSON.stringify({ accept: true, issues: '' });
const REJECTED = JSON.stringify({ accept: false, issues: '目标不在候选里' });

let frozen: Promise<FrozenPrompts> | undefined;

/** 平台连不上，整局走本地兜底。冻结一次就够，图的用例不关心平台。 */
function prompts(): Promise<FrozenPrompts> {
  frozen ??= freezeTurnPrompts({ load: () => Promise.reject(new Error('平台连不上')) });
  return frozen;
}

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    scope: SCOPE,
    actionType: ACTION_TYPES.VOTE,
    actorId: 'p3',
    actionOrdinal: 0,
    preset: 'quick',
    context: CONTEXT,
    schema: DECISION_SCHEMA,
    ...overrides,
  };
}

/** 造一份脚本模型加它对应的运行环境；calls 用来断言问了几次、问了什么。 */
async function withModel(answers: readonly (string | Error)[]) {
  const model = scriptedModel(answers);
  const runtime: TurnRuntime = { port: model, access: ACCESS, prompts: await prompts() };
  return { model, runtime };
}

describe('单玩家行动图', () => {
  it('quick 档生成完就交，不再往下问', async () => {
    const { model, runtime } = await withModel([DECIDED]);

    const outcome = await runActionGraph(runtime, request());

    expect(model.calls).toHaveLength(1);
    expect(outcome.decision).toEqual({ targetId: 'p2', reason: '他发言太稳了' });
    expect(outcome.snapshot.critique).toBeNull();
  });

  it('quality 档质疑通过就不再修订，结果还是生成那一版', async () => {
    const { model, runtime } = await withModel([DECIDED, ACCEPTED]);

    const outcome = await runActionGraph(runtime, request({ preset: 'quality' }));

    expect(model.calls).toHaveLength(2);
    expect(outcome.snapshot.critique).toEqual({ accept: true, issues: '' });
    expect(outcome.decision).toEqual({ targetId: 'p2', reason: '他发言太稳了' });
    expect(outcome.snapshot.draft).toBe(DECIDED);
  });

  it('quality 档质疑不通过就改一版，采用的是改后那版', async () => {
    const { model, runtime } = await withModel([DECIDED, REJECTED, REVISED]);

    const outcome = await runActionGraph(runtime, request({ preset: 'quality' }));

    expect(model.calls).toHaveLength(3);
    expect(outcome.decision).toEqual({ targetId: 'p1', reason: '他才是最该出局的那个' });
    expect(outcome.snapshot.draft).toBe(REVISED);
    expect(outcome.snapshot.prompts.map((prompt) => prompt.template)).toEqual([
      TURN_PROMPT_NAMES.generateSystem,
      TURN_PROMPT_NAMES.generateUser,
      TURN_PROMPT_NAMES.critiqueSystem,
      TURN_PROMPT_NAMES.critiqueUser,
      TURN_PROMPT_NAMES.reviseSystem,
      TURN_PROMPT_NAMES.reviseUser,
    ]);
  });

  it('质疑只拿到任务和草稿，拿不到生成时那套系统提示词', async () => {
    const { model, runtime } = await withModel([DECIDED, ACCEPTED]);

    await runActionGraph(runtime, request({ preset: 'quality' }));

    const [generate, critique] = model.calls;
    expect(critique.system).not.toBe(generate.system);
    expect(critique.prompt).toContain(DECIDED);
    expect(critique.prompt).not.toContain(generate.system);
  });

  it('质疑要的输出形状就是拿它解析的那份，不是决定的结构', async () => {
    const { model, runtime } = await withModel([DECIDED, ACCEPTED]);

    await runActionGraph(runtime, request({ preset: 'quality' }));

    const [, critique] = model.calls;
    expect(critique.prompt).toContain('"accept"');
    expect(critique.prompt).toContain('"issues"');
  });

  it('没有 schema 的行动，草稿原文就是结果', async () => {
    const { model, runtime } = await withModel(['我先说说我的看法，1 号跳得有点急。']);

    const outcome = await runActionGraph(
      runtime,
      request({ actionType: ACTION_TYPES.SPEECH, schema: undefined }),
    );

    expect(model.calls).toHaveLength(1);
    expect(outcome.decision).toBe('我先说说我的看法，1 号跳得有点急。');
    expect(outcome.snapshot.schema).toBeNull();
  });

  it('两档用的是同一份校验，不合结构的输出都拦得住', async () => {
    const bad = JSON.stringify({ targetId: 7, reason: 'x' });

    await expect(
      runActionGraph((await withModel([bad])).runtime, request({ preset: 'quick' })),
    ).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(
      runActionGraph((await withModel([bad, ACCEPTED])).runtime, request({ preset: 'quality' })),
    ).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('质疑自己答得不成样子，也是同一个错拦下来', async () => {
    const { model, runtime } = await withModel([
      DECIDED,
      JSON.stringify({ accept: '行', issues: 1 }),
    ]);

    await expect(runActionGraph(runtime, request({ preset: 'quality' }))).rejects.toMatchObject({
      code: 'invalid_output',
    });
    expect(model.calls).toHaveLength(2);
  });

  it('模型说的不是 JSON 就抛出来，不替它猜', async () => {
    const { runtime } = await withModel(['我觉得应该投 2 号']);

    await expect(runActionGraph(runtime, request())).rejects.toMatchObject({
      code: 'invalid_output',
    });
  });

  it('模型自己抛的错原样上抛，不吞也不重试', async () => {
    const failure = new ModelCallError('fatal', '端点把请求拒了');
    const { model, runtime } = await withModel([failure]);

    await expect(runActionGraph(runtime, request())).rejects.toBe(failure);
    expect(model.calls).toHaveLength(1);
  });

  it('快照记得住决定是怎么来的，但不带端点与密钥', async () => {
    const { runtime } = await withModel([DECIDED]);
    const next = actionOrdinals();
    const ordinal = next(SCOPE, ACTION_TYPES.VOTE, 'p3');

    const outcome = await runActionGraph(runtime, request({ actionOrdinal: ordinal }));

    expect(outcome.snapshot.actionKey).toBe(actionKey(SCOPE, ACTION_TYPES.VOTE, 'p3', ordinal));
    expect(outcome.snapshot.actionOrdinal).toBe(ordinal);
    expect(outcome.snapshot.capability).toEqual(CAPABILITY);
    expect(outcome.snapshot.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.snapshot.prompts[0]?.source).toBe('local');

    const serialized = JSON.stringify(outcome.snapshot);
    expect(serialized).not.toContain(ACCESS.baseUrl);
    expect(serialized).not.toContain('sk-不能进快照');
  });

  it('同样的输入跑两次，冻结哈希对得上', async () => {
    const first = await runActionGraph((await withModel([DECIDED])).runtime, request());
    const second = await runActionGraph((await withModel([DECIDED])).runtime, request());

    expect(first.snapshot.inputHash).toBe(second.snapshot.inputHash);
  });

  it('逐段发言里同一个人的多次行动，靠序号区分开', async () => {
    const next = actionOrdinals();
    const asks = [0, 1, 2].map(async () =>
      runActionGraph(
        (await withModel([DECIDED])).runtime,
        request({ actionOrdinal: next(SCOPE, ACTION_TYPES.VOTE, 'p3') }),
      ),
    );

    const keys = (await Promise.all(asks)).map((outcome) => outcome.snapshot.actionKey);

    expect(new Set(keys).size).toBe(3);
  });
});
