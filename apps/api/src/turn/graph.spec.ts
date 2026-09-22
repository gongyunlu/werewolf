import { MemorySaver } from '@langchain/langgraph';
import type { Checkpoint, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint';
import { ACTION_TYPES } from '@werewolf/shared';
import { z } from 'zod';
import { actionKey, phaseInstanceId, type ActionScope } from '../core/identity';
import type { ModelCapability } from '../llm/model-capability';
import {
  ModelCallError,
  type ModelAccess,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
} from '../llm/model-port';
import { stubSkills } from '../testing/fixtures';
import { scriptedModel, type ScriptedStep } from '../testing/model';
import { runActionGraph } from './graph';
import { LOCAL_TURN_PROMPTS, TURN_PROMPT_NAMES } from './prompt';
import {
  actionKeyOf,
  actionOrdinals,
  type ActionRequest,
  type TurnContext,
  type TurnRuntime,
} from './request';

const CAPABILITY: ModelCapability = { reasoningOff: null };

const ACCESS: ModelAccess = {
  baseUrl: 'https://model.example.test/v1',
  model: '用例模型',
  apiKey: 'sk-不能进快照',
  capability: CAPABILITY,
};

const SCOPE: ActionScope = { gameId: 'g1', phaseInstanceId: phaseInstanceId(3, 'vote') };

const DECISION_SCHEMA = z.object({ targetId: z.string().nullable(), reason: z.string() });

const CONTEXT: TurnContext = {
  task: '投票决定放逐谁。',
  actor: { playerId: 'p3', seatNo: 3, role: '预言家' },
  day: 2,
  visible: [{ title: '局面', lines: ['1 号昨天跳了预言家'] }],
  options: ['1 号 p1', '2 号 p2'],
  skill: [],
};

const DECIDED = JSON.stringify({ targetId: 'p2', reason: '他发言太稳了' });
const REVISED = JSON.stringify({ targetId: 'p1', reason: '他才是最该出局的那个' });
const ACCEPTED = JSON.stringify({ accept: true, issues: '' });
const REJECTED = JSON.stringify({ accept: false, issues: '目标不在候选里' });

/**
 * 模型交回来的原话：走工具那一问的参数裹着壳（见 decisions 的 toolOf）。
 * 脚本里写的是壳里那个值，快照里存的、质疑看到的是这一份。
 */
function wrapped(answer: string): string {
  return `{"value":${answer}}`;
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

/** 端口加它对应的运行环境；接入身份与提示词来处各条用例都一样。 */
function runtimeOf(port: ModelPort): TurnRuntime {
  return { port, access: ACCESS, promptSource: LOCAL_TURN_PROMPTS, skills: stubSkills() };
}

/** 造一份脚本模型加它对应的运行环境；calls 用来断言问了几次、问了什么。 */
async function withModel(answers: readonly ScriptedStep[]) {
  const model = scriptedModel(answers);
  return { model, runtime: runtimeOf(model) };
}

/**
 * 交什么就原样交什么的端口：脚本模型会把答案裹进规定的壳里，
 * 而「壳本身没交对」那一路只能靠它交一份原样的出来。
 */
function rawModel(raws: readonly string[]) {
  const calls: ModelRequest[] = [];
  const port: ModelPort = {
    generate(asked) {
      calls.push(asked);
      return Promise.resolve({
        content: '',
        toolCall: { name: 'submit', arguments: raws[calls.length - 1] ?? '' },
        reasoning: null,
      });
    },
  };
  return { port, calls };
}

/** 每次落盘都把线程键记下来的存储：看得见框架递给存储的到底是哪一份配置。 */
class RecordingSaver extends MemorySaver {
  readonly threads: unknown[] = [];

  override async put(
    config: { configurable?: Record<string, unknown> },
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ) {
    this.threads.push(config.configurable?.thread_id);
    return super.put(config, checkpoint, metadata);
  }

  override async putWrites(
    config: { configurable?: Record<string, unknown> },
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    this.threads.push(config.configurable?.thread_id);
    return super.putWrites(config, writes, taskId);
  }
}

describe('单玩家行动图', () => {
  it('quick 档生成完就交，不再往下问', async () => {
    const { model, runtime } = await withModel([DECIDED]);

    const outcome = await runActionGraph(runtime, request());

    expect(model.calls).toHaveLength(1);
    expect(outcome.decision).toEqual({ targetId: 'p2', reason: '他发言太稳了' });
    expect(outcome.snapshot.critique).toBeNull();
    // 一次就交对的那一问，别把次数也记成一。
    expect(outcome.snapshot.retries).toBe(0);
  });

  it('quality 档质疑通过就不再修订，结果还是生成那一版', async () => {
    const { model, runtime } = await withModel([DECIDED, ACCEPTED]);

    const outcome = await runActionGraph(runtime, request({ preset: 'quality' }));

    expect(model.calls).toHaveLength(2);
    expect(outcome.snapshot.critique).toEqual({ accept: true, issues: '' });
    expect(outcome.decision).toEqual({ targetId: 'p2', reason: '他发言太稳了' });
    expect(outcome.snapshot.draft).toBe(wrapped(DECIDED));
  });

  it('quality 档质疑不通过就改一版，采用的是改后那版', async () => {
    const { model, runtime } = await withModel([DECIDED, REJECTED, REVISED]);

    const outcome = await runActionGraph(runtime, request({ preset: 'quality' }));

    expect(model.calls).toHaveLength(3);
    expect(outcome.decision).toEqual({ targetId: 'p1', reason: '他才是最该出局的那个' });
    expect(outcome.snapshot.draft).toBe(wrapped(REVISED));
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
    expect(critique.prompt).toContain(wrapped(DECIDED));
    expect(critique.prompt).not.toContain(generate.system);
  });

  it('质疑看到的形状跟草稿同一层，就是生成那一问的工具定义', async () => {
    const { model, runtime } = await withModel([DECIDED, ACCEPTED]);

    await runActionGraph(runtime, request({ preset: 'quality' }));

    const [generate, critique] = model.calls;
    // 草稿是工具参数那一串，裹着壳；形状也得是裹着壳的那一份，不然壳会被它判成形式错误。
    expect(critique.prompt).toContain(JSON.stringify(generate.tool?.parameters, null, 2));
  });

  it('质疑要的输出形状就是拿它解析的那份，不是决定的结构', async () => {
    const { model, runtime } = await withModel([DECIDED, ACCEPTED]);

    await runActionGraph(runtime, request({ preset: 'quality' }));

    const [, critique] = model.calls;
    expect(critique.tool?.parameters).toMatchObject({
      properties: {
        value: { properties: { accept: { type: 'boolean' }, issues: { type: 'string' } } },
      },
    });
    // 要它交的是自己那套固定形状，不是这次决策的结构。
    expect(JSON.stringify(critique.tool?.parameters)).not.toContain('targetId');
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

  it('答歪一次，带着交过的那份和候选再问一遍就成', async () => {
    const bad = JSON.stringify({ targetId: 7, reason: 'x' });
    const { model, runtime } = await withModel([bad, DECIDED]);

    const outcome = await runActionGraph(runtime, request());

    expect(outcome.decision).toEqual({ targetId: 'p2', reason: '他发言太稳了' });
    expect(model.calls).toHaveLength(2);
    expect(outcome.snapshot.retries).toBe(1);

    // 再问的不能是同一份题面：一字不改地再发一遍，模型没有理由换个答案。
    const [first, second] = model.calls;
    expect(second.system).toBe(first.system);
    expect(second.prompt.startsWith(first.prompt)).toBe(true);
    // 附回去的是那两件事：交上来的是什么、这次能选什么。
    expect(second.prompt).toContain(wrapped(bad));
    expect(second.prompt).toContain('1 号 p1、2 号 p2');
  });

  it('答歪两次，第三次才成', async () => {
    const bad = JSON.stringify({ targetId: 7, reason: 'x' });
    const { model, runtime } = await withModel([bad, bad, DECIDED]);

    const outcome = await runActionGraph(runtime, request());

    expect(outcome.decision).toEqual({ targetId: 'p2', reason: '他发言太稳了' });
    expect(model.calls).toHaveLength(3);
    expect(outcome.snapshot.retries).toBe(2);
  });

  it('给了工具却只写了一段话，重问点明它没交值，并把它写的那段带回去', async () => {
    const refused = '这个提交工具只接受 2 号或 3 号，我要交的东西表达不出来。';
    const { model, runtime } = await withModel([{ refusal: refused }, DECIDED]);

    const outcome = await runActionGraph(runtime, request());

    expect(outcome.decision).toEqual({ targetId: 'p2', reason: '他发言太稳了' });
    expect(model.calls).toHaveLength(2);
    expect(outcome.snapshot.retries).toBe(1);
    // 诊断得说「没走工具交」：它写的那段话本来就不是 JSON，说成「不是合法 JSON」等于指错了地方。
    expect(model.calls[1].prompt).toContain('没走工具交');
    expect(model.calls[1].prompt).toContain(refused);
  });

  it('三次都只写话、一个值都不交，整局停在这一问', async () => {
    const refused = '我不打算用那个工具交。';
    const { model, runtime } = await withModel([
      { refusal: refused },
      { refusal: refused },
      { refusal: refused },
    ]);

    await expect(runActionGraph(runtime, request())).rejects.toThrow('没走工具交');
    expect(model.calls).toHaveLength(3);
  });

  it('修订那一次答歪，也带着交过的那份和候选再问一遍', async () => {
    const bad = JSON.stringify({ targetId: 7, reason: 'x' });
    const { model, runtime } = await withModel([DECIDED, REJECTED, bad, REVISED]);

    const outcome = await runActionGraph(runtime, request({ preset: 'quality' }));

    expect(outcome.decision).toEqual({ targetId: 'p1', reason: '他才是最该出局的那个' });
    expect(outcome.snapshot.retries).toBe(1);
    // 生成、质疑、修订各问各的：第四回才是修订重问的那一次。
    expect(model.calls[3].prompt).toContain(wrapped(bad));
    expect(model.calls[3].prompt).toContain('1 号 p1、2 号 p2');
  });

  it.each<[string, string]>([
    ['整串不是合法 JSON', '我觉得应该投 2 号'],
    ['没裹在规定的那个对象里', 'null'],
    // 忘了裹壳也归这一类：说成「值不对」，它会去改值而不是补壳。
    ['没裹在规定的那个对象里', JSON.stringify({ targetId: 7, reason: 'x' })],
    ['交的那个值不合这次要求的形状', JSON.stringify({ value: 7 })],
  ])('交的属于「%s」这一类，重问的附言就照这一类说', async (diagnosis, bad) => {
    const { port, calls } = rawModel([bad, wrapped(DECIDED)]);

    const outcome = await runActionGraph(runtimeOf(port), request());

    expect(outcome.decision).toEqual({ targetId: 'p2', reason: '他发言太稳了' });
    // 只说「不合要求」，模型只能照着原样再掷一次；说清错在哪一类，它才知道往哪儿改。
    expect(calls[1].prompt).toContain(diagnosis);
    // 末句点它去思考里说清改选的理由：这一问的思考是要留下来给人看的。
    expect(calls[1].prompt).toContain('重交时在思考里说清上一次为什么不成立、这次为什么改选它。');
  });

  it('质疑那一问重问不带末句：它的推理不留，不点它去说理', async () => {
    const bad = JSON.stringify({ accept: '行', issues: 1 });
    const { model, runtime } = await withModel([DECIDED, bad, ACCEPTED]);

    await runActionGraph(runtime, request({ preset: 'quality' }));

    // 生成、质疑、质疑重问：第三次才是重问的那一次。
    expect(model.calls[2].prompt).toContain('交的那个值不合这次要求的形状');
    expect(model.calls[2].prompt).not.toContain('在思考里说清');
    // 工具说明写的是这一问要交的东西，照抄决定的题面会让它答偏。
    expect(model.calls[1].tool?.description).toBe('这次质疑的结论');
  });

  it('工具参数整串就是个 null，也当不合规，重问三次才抛', async () => {
    let calls = 0;
    const runtime: TurnRuntime = {
      port: {
        async generate(): Promise<ModelResponse> {
          calls += 1;
          return { content: '', toolCall: { name: 'submit', arguments: 'null' }, reasoning: null };
        },
      },
      access: ACCESS,
      promptSource: LOCAL_TURN_PROMPTS,
      skills: stubSkills(),
    };

    // 取那个壳的字段会抛裸 TypeError，不是 ModelCallError——重问那层认不出来就会跳过重问，
    // 整局停在这一问。
    await expect(runActionGraph(runtime, request())).rejects.toMatchObject({
      code: 'invalid_output',
    });
    expect(calls).toBe(3);
  });

  it('一趟里两个节点各歪一次，总数是两次', async () => {
    const badDecision = JSON.stringify({ targetId: 7, reason: 'x' });
    const badCritique = JSON.stringify({ accept: '行', issues: 1 });
    const { runtime } = await withModel([badDecision, DECIDED, badCritique, ACCEPTED]);

    const outcome = await runActionGraph(runtime, request({ preset: 'quality' }));

    // 各记各的再相加；只记最后一处的话，前面歪过的那几次就查不出来了。
    expect(outcome.snapshot.retries).toBe(2);
  });

  it('两档用的是同一份校验，不合结构的输出都拦得住', async () => {
    const bad = JSON.stringify({ targetId: 7, reason: 'x' });

    // 每次都得给一份不合结构的：重问两次还是错的，才轮到抛。
    await expect(
      runActionGraph((await withModel([bad, bad, bad])).runtime, request({ preset: 'quick' })),
    ).rejects.toMatchObject({ code: 'invalid_output' });
    // 交上来的原物一并写进错里：跑完一局回来得能查出它答了什么。
    await expect(
      runActionGraph((await withModel([bad, bad, bad])).runtime, request({ preset: 'quality' })),
    ).rejects.toThrow(bad);
    // 连 JSON 都不是的那一类同样要留原话；散文里没有别的字段可留。
    const notJson = rawModel(['我觉得应该投 2 号', '我觉得应该投 2 号', '我觉得应该投 2 号']);
    await expect(runActionGraph(runtimeOf(notJson.port), request())).rejects.toThrow(
      '交上来的是 我觉得应该投 2 号',
    );
  });

  it('质疑自己答得不成样子，也是同一个错拦下来', async () => {
    const bad = JSON.stringify({ accept: '行', issues: 1 });
    const { model, runtime } = await withModel([DECIDED, bad, bad, bad]);

    await expect(runActionGraph(runtime, request({ preset: 'quality' }))).rejects.toMatchObject({
      code: 'invalid_output',
    });
    // 生成一次，质疑那里重问了两次才放弃。
    expect(model.calls).toHaveLength(4);
    // 质疑那一问没有候选，说明里只报交过的是什么、这次要按形状交。
    expect(model.calls[2].prompt).toContain(bad);
    expect(model.calls[2].prompt).toContain('按题里写明的形状交');
  });

  it('模型说的不是 JSON 就抛出来，不替它猜', async () => {
    const { runtime } = await withModel(['我觉得应该投 2 号', '我觉得应该投 2 号', '投 2 号']);

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

  it('模型自己那段推理跟着决定一起落进快照；端点没给就是 null，不是空串', async () => {
    const { runtime } = await withModel([{ answer: DECIDED, reasoning: '他发言太稳，先投他' }]);

    const outcome = await runActionGraph(runtime, request());

    expect(outcome.snapshot.reasoning).toBe('他发言太稳，先投他');
    expect(
      (await runActionGraph((await withModel([DECIDED])).runtime, request())).snapshot.reasoning,
    ).toBeNull();
  });

  it('改过一版之后留的是改那版的推理，生成与质疑那两问的都不留', async () => {
    const { runtime } = await withModel([
      { answer: DECIDED, reasoning: '生成时的想法' },
      { answer: REJECTED, reasoning: '质疑时的想法' },
      { answer: REVISED, reasoning: '改过之后的想法' },
    ]);

    const outcome = await runActionGraph(runtime, request({ preset: 'quality' }));

    // 最终那版决定的推理才是要留的：生成那版已经被换掉，质疑只判行不行、不构成依据。
    expect(outcome.snapshot.reasoning).toBe('改过之后的想法');
    expect(JSON.stringify(outcome.snapshot)).not.toContain('生成时的想法');
    expect(JSON.stringify(outcome.snapshot)).not.toContain('质疑时的想法');
  });

  it('重问之后，留下的是最后交对那版的推理', async () => {
    const bad = JSON.stringify({ targetId: 7, reason: 'x' });
    const { runtime } = await withModel([
      { answer: bad, reasoning: '交歪那版的推理' },
      { answer: DECIDED, reasoning: '改对那版的推理' },
    ]);

    const outcome = await runActionGraph(runtime, request());

    expect(outcome.snapshot.reasoning).toBe('改对那版的推理');
    expect(JSON.stringify(outcome.snapshot)).not.toContain('交歪那版的推理');
  });

  it('快照记得住决定是怎么来的，但不带端点与密钥', async () => {
    const { runtime } = await withModel([DECIDED]);
    const next = actionOrdinals();
    const ordinal = next(SCOPE, ACTION_TYPES.VOTE, 'p3');

    const outcome = await runActionGraph(runtime, request({ actionOrdinal: ordinal }));

    expect(outcome.snapshot.actionKey).toBe(actionKey(SCOPE, ACTION_TYPES.VOTE, 'p3', ordinal));
    expect(outcome.snapshot.actionOrdinal).toBe(ordinal);
    expect(outcome.snapshot.capability).toEqual(CAPABILITY);
    expect(outcome.snapshot.model).toBe(ACCESS.model);
    expect(outcome.snapshot.prompts[0]?.source).toBe('local');

    const serialized = JSON.stringify(outcome.snapshot);
    expect(serialized).not.toContain(ACCESS.baseUrl);
    expect(serialized).not.toContain('sk-不能进快照');
  });

  it('同一个人的多次行动，靠序号区分开', async () => {
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

describe('执行进度落盘与接着跑', () => {
  it('每次落盘都带着行动键那条线程：库那边的进度按它认这一局', async () => {
    const saver = new RecordingSaver();
    const ask = request({ preset: 'quality' });
    await runActionGraph((await withModel([DECIDED, REJECTED, REVISED])).runtime, ask, { saver });

    // 一整跑要落好几份，框架在几份配置之间倒过手：哪一份丢了线程键，库那边就认不出这一局。
    expect(saver.threads.length).toBeGreaterThan(3);
    expect(saver.threads.every((thread) => thread === actionKeyOf(ask))).toBe(true);
    // 两边同一个函数还不够：库那边是拿第一段当对局标识用的（见 checkpoints 的 gameIdOf），
    // 行动键的元组哪天把对局挪到别的位上，这里得跟着红。
    expect(JSON.parse(actionKeyOf(ask))[0]).toBe(ask.scope.gameId);
  });

  it('断在质疑那一跑：接着跑从质疑往下走，生成不再重问', async () => {
    const saver = new MemorySaver();
    const broken = await withModel([DECIDED, new Error('这一跑断在这儿')]);
    await expect(
      runActionGraph(broken.runtime, request({ preset: 'quality' }), { saver }),
    ).rejects.toThrow('这一跑断在这儿');

    // 换一个模型接着跑：不认断点的话它会拿着这份新脚本从头问起，第一格就露馅。
    const resumed = await withModel([ACCEPTED]);
    const outcome = await runActionGraph(resumed.runtime, request({ preset: 'quality' }), {
      saver,
      resume: true,
    });

    expect(resumed.model.calls).toHaveLength(1);
    // 草稿来自断点里那一份，不是这一跑重新问出来的。
    expect(outcome.snapshot.draft).toBe(wrapped(DECIDED));
    expect(outcome.decision).toEqual({ targetId: 'p2', reason: '他发言太稳了' });
    // 这一问用过的提示词一路带着走：接着跑交出来的这份跟整跑跑出来的一样全。
    expect(outcome.snapshot.prompts.map((prompt) => prompt.template)).toEqual([
      TURN_PROMPT_NAMES.generateSystem,
      TURN_PROMPT_NAMES.generateUser,
      TURN_PROMPT_NAMES.critiqueSystem,
      TURN_PROMPT_NAMES.critiqueUser,
    ]);
  });

  it('整条线程已经跑完：标着接着跑也不重问，原样交回那一份结果', async () => {
    const saver = new MemorySaver();
    const first = await runActionGraph((await withModel([DECIDED])).runtime, request(), { saver });

    // 答完了却没来得及补结果的那种断法：图上什么都不用再跑，结果就在断点里。
    const again = await withModel([]);
    const outcome = await runActionGraph(again.runtime, request(), { saver, resume: true });

    expect(again.model.calls).toHaveLength(0);
    expect(outcome).toEqual(first);
  });

  it('同一份存储上的两次行动各走各的线程，谁也不接谁的进度', async () => {
    const saver = new MemorySaver();
    const first = await runActionGraph((await withModel([DECIDED])).runtime, request(), { saver });
    const other = request({ actorId: 'p4', actionType: ACTION_TYPES.SPEECH, schema: undefined });
    const second = await runActionGraph((await withModel(['我过。'])).runtime, other, { saver });

    expect(second.decision).toBe('我过。');
    // 把头一次那份接着跑回来，交出来的还是它自己那份，没被后一问顶掉。
    const again = await withModel([]);
    expect(await runActionGraph(again.runtime, request(), { saver, resume: true })).toEqual(first);
  });

  it('图上一步都没落下：标着接着跑也从头问起', async () => {
    const { model, runtime } = await withModel([DECIDED]);

    // 立了意图就断了的那种：空线程拿 null 起跑会当场抛，得认清这一点再决定喂什么进去。
    const outcome = await runActionGraph(runtime, request(), {
      saver: new MemorySaver(),
      resume: true,
    });

    expect(model.calls).toHaveLength(1);
    expect(outcome.decision).toEqual({ targetId: 'p2', reason: '他发言太稳了' });
  });
});
