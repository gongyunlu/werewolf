import type { PromptSource } from '../llm/prompt-template';
import {
  LOCAL_TURN_PROMPTS,
  renderCritique,
  renderGenerate,
  renderRevise,
  TURN_PROMPT_NAMES,
} from './prompt';
import type { TurnContext } from './request';

const context: TurnContext = {
  task: '投票决定放逐谁。',
  actor: { playerId: 'p3', seatNo: 3, role: '预言家' },
  day: 2,
  visible: [
    { title: '局面', lines: ['1 号昨天跳了预言家', '2 号还没发过言'] },
    { title: '公开发言', lines: ['【第 2 天】', '1 号发言：我是预言家。'] },
  ],
  options: ['1 号 p1', '2 号 p2'],
  skill: ['板子正文', '角色正文', '场景正文'],
};

const SCHEMA_JSON = { type: 'object', properties: { targetId: { type: 'string' } } };

/** 平台连不上，取到哪条哪条退到本地兜底。 */
const offline: PromptSource = { load: () => Promise.reject(new Error('平台连不上')) };

describe('提示词渲染', () => {
  it('生成提示词带上身份、天数、已知事实和这次能选什么', async () => {
    const turn = await renderGenerate(offline, context, SCHEMA_JSON);

    expect(turn.system.text).toContain('3 号');
    expect(turn.system.text).toContain('预言家');
    expect(turn.user.text).toContain('第 2 天');
    expect(turn.user.text).toContain('1 号昨天跳了预言家');
    expect(turn.user.text).toContain('投票决定放逐谁');
    expect(turn.user.text).toContain('1 号 p1');
  });

  it('可见事实按块渲染，一块一个小标题', async () => {
    const turn = await renderGenerate(offline, context, SCHEMA_JSON);

    expect(turn.user.text).toContain(
      [
        '你已知的事实：',
        '【局面】',
        '- 1 号昨天跳了预言家',
        '- 2 号还没发过言',
        '',
        '【公开发言】',
        '【第 2 天】',
        '- 1 号发言：我是预言家。',
      ].join('\n'),
    );
    // 台账换天那一行是分隔不是事实，不挂项目符号。
    expect(turn.user.text).not.toContain('- 【第 2 天】');
  });

  it('有形状的让他走工具交，没有形状的让他写一段话', async () => {
    expect((await renderGenerate(offline, context, SCHEMA_JSON)).user.text).toContain(
      '用规定好的那个工具交上来',
    );
    expect((await renderGenerate(offline, context, null)).user.text).toContain(
      '结果直接写成一段话',
    );
  });

  it('候选为空时那一段整段消失，不留一个光秃秃的标题', async () => {
    const turn = await renderGenerate(offline, { ...context, options: [] }, SCHEMA_JSON);

    expect(turn.user.text).not.toContain('可以选的目标只有下面这些');
  });

  it('技能正文接在系统提示词正文之后，按给它的顺序', async () => {
    const turn = await renderGenerate(offline, context, SCHEMA_JSON);

    expect(turn.system.text).toContain('板子正文\n\n角色正文\n\n场景正文');
    expect(turn.system.text.indexOf('板子正文')).toBeGreaterThan(
      turn.system.text.indexOf('别替规则补全。'),
    );
  });

  it('没有技能正文就不接那一段，末尾不留空行', async () => {
    const turn = await renderGenerate(offline, { ...context, skill: [] }, SCHEMA_JSON);

    expect(turn.system.text).not.toContain('板子正文');
    expect(turn.system.text.endsWith('保持原样。')).toBe(true);
    expect(turn.system.text).toContain('推理过程也使用简体中文');
  });

  it('复核只拿板子规则，角色和场景策略只给生成与修订', async () => {
    const critique = await renderCritique(offline, context, '{"targetId":"p1"}', SCHEMA_JSON);
    const revise = await renderRevise(
      offline,
      context,
      '{"targetId":"p1"}',
      '理由不成立',
      SCHEMA_JSON,
    );

    expect(critique.system.text).toContain('板子正文');
    expect(critique.system.text).not.toContain('角色正文');
    expect(critique.system.text).not.toContain('场景正文');
    expect(revise.system.text).toContain('板子正文');
  });

  it('同一份局面渲染两次一模一样', async () => {
    const once = await renderGenerate(offline, context, SCHEMA_JSON);

    expect(once).toEqual(await renderGenerate(offline, context, SCHEMA_JSON));
  });

  it('质疑只拿到任务和草稿，拿不到生成时的系统提示词', async () => {
    const generate = await renderGenerate(offline, context, SCHEMA_JSON);
    const critique = await renderCritique(offline, context, '{"targetId":"p1"}', SCHEMA_JSON);

    expect(critique.system.text).not.toBe(generate.system.text);
    expect(critique.user.text).toContain('投票决定放逐谁');
    expect(critique.user.text).toContain('{"targetId":"p1"}');
    expect(critique.user.text).not.toContain(generate.system.text);
  });

  it('质疑拿得到候选，不然「目标不在候选里」这一条没法判', async () => {
    const critique = await renderCritique(offline, context, '{"targetId":"p1"}', SCHEMA_JSON);

    expect(critique.user.text).toContain('1 号 p1');
  });

  it('修订带着上一版和审核意见一起给', async () => {
    const revise = await renderRevise(
      offline,
      context,
      '{"targetId":"p1"}',
      '目标不在候选里',
      SCHEMA_JSON,
    );

    expect(revise.user.text).toContain('{"targetId":"p1"}');
    expect(revise.user.text).toContain('目标不在候选里');
  });

  it('修订只要一次输出说明，不会同时要求「写成一段话」和走工具', async () => {
    const revise = await renderRevise(offline, context, '草稿', '意见', SCHEMA_JSON);

    expect(revise.user.text).not.toContain('结果直接写成一段话');
    expect(revise.user.text.match(/用规定好的那个工具交上来/g)).toHaveLength(1);
  });

  it('每段都记得住自己出自哪条模板、哪个来源', async () => {
    const turn = await renderGenerate(offline, context, SCHEMA_JSON);

    expect(turn.system.template).toBe(TURN_PROMPT_NAMES.generateSystem);
    expect(turn.user.template).toBe(TURN_PROMPT_NAMES.generateUser);
    expect(turn.system.source).toBe('local');
    expect(turn.system.version).toBeNull();
  });
});

describe('提示词从哪来', () => {
  it('平台取得到就用平台那份，正文与版本都跟着走', async () => {
    const platform: PromptSource = {
      async load(name) {
        const local = await LOCAL_TURN_PROMPTS.load(name);
        return { ...local, text: `${local.text}\n平台加的尾巴`, version: 7, source: 'platform' };
      },
    };

    const turn = await renderGenerate(platform, context, null);

    expect(turn.user.source).toBe('platform');
    expect(turn.user.version).toBe(7);
    expect(turn.user.text).toContain('平台加的尾巴');
  });

  it('平台少一条就那一条退到本地，其余还是平台的', async () => {
    const half: PromptSource = {
      async load(name) {
        if (name === TURN_PROMPT_NAMES.critiqueUser) throw new Error('这条没了');
        const local = await LOCAL_TURN_PROMPTS.load(name);
        return { ...local, version: 3, source: 'platform' };
      },
    };

    const generate = await renderGenerate(half, context, null);
    const critique = await renderCritique(half, context, '草稿', null);

    expect(generate.system.source).toBe('platform');
    expect(generate.system.version).toBe(3);
    expect(critique.system.source).toBe('platform');
    expect(critique.user.source).toBe('local');
    expect(critique.user.version).toBeNull();
  });

  it('一次渲染只取它自己那两条，取的时候是现取的', async () => {
    const seen: string[] = [];
    const counting: PromptSource = {
      async load(name) {
        seen.push(name);
        return LOCAL_TURN_PROMPTS.load(name);
      },
    };

    await renderGenerate(counting, context, null);

    expect(seen).toEqual([TURN_PROMPT_NAMES.generateSystem, TURN_PROMPT_NAMES.generateUser]);
  });

  it('平台上的模板被改得缺了必需变量，当场抛，不回退', async () => {
    const broken: PromptSource = {
      async load(name) {
        return { name, text: '这段里什么变量都没有', version: 1, source: 'platform' };
      },
    };

    await expect(renderGenerate(broken, context, null)).rejects.toMatchObject({
      name: 'PromptContractError',
    });
  });
});
