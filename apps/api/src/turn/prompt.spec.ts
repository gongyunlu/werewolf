import type { PromptSource } from '../llm/prompt-template';
import {
  freezeTurnPrompts,
  LOCAL_TURN_PROMPTS,
  renderCritique,
  renderGenerate,
  renderRevise,
  TURN_PROMPT_NAMES,
  TURN_PROMPT_NAMES_ALL,
  type FrozenPrompts,
} from './prompt';
import type { TurnContext } from './request';

const context: TurnContext = {
  task: '投票决定放逐谁。',
  actor: { playerId: 'p3', seatNo: 3, role: '预言家' },
  day: 2,
  visible: ['1 号昨天跳了预言家', '2 号还没发过言'],
  options: ['1 号 p1', '2 号 p2'],
};

const SCHEMA_JSON = { type: 'object', properties: { targetId: { type: 'string' } } };

/** 平台连不上，整局走本地兜底。 */
const offline: PromptSource = { load: () => Promise.reject(new Error('平台连不上')) };

function localPrompts(): Promise<FrozenPrompts> {
  return freezeTurnPrompts(offline);
}

describe('提示词渲染', () => {
  it('生成提示词带上身份、天数、已知事实和这次能选什么', async () => {
    const frozen = await localPrompts();
    const turn = renderGenerate(frozen, context, SCHEMA_JSON);

    expect(turn.system.text).toContain('3 号');
    expect(turn.system.text).toContain('预言家');
    expect(turn.user.text).toContain('第 2 天');
    expect(turn.user.text).toContain('1 号昨天跳了预言家');
    expect(turn.user.text).toContain('投票决定放逐谁');
    expect(turn.user.text).toContain('1 号 p1');
  });

  it('有 schema 就把 schema 原文给他，没有就让他写一段话', async () => {
    const frozen = await localPrompts();

    expect(renderGenerate(frozen, context, SCHEMA_JSON).user.text).toContain('"targetId"');
    expect(renderGenerate(frozen, context, null).user.text).toContain('结果直接写成一段话');
  });

  it('候选为空时那一段整段消失，不留一个光秃秃的标题', async () => {
    const frozen = await localPrompts();
    const turn = renderGenerate(frozen, { ...context, options: [] }, SCHEMA_JSON);

    expect(turn.user.text).not.toContain('可以选的目标只有下面这些');
  });

  it('同一份局面渲染两次一模一样', async () => {
    const frozen = await localPrompts();
    const once = renderGenerate(frozen, context, SCHEMA_JSON);

    expect(once).toEqual(renderGenerate(frozen, context, SCHEMA_JSON));
  });

  it('质疑只拿到任务和草稿，拿不到生成时的系统提示词', async () => {
    const frozen = await localPrompts();
    const generate = renderGenerate(frozen, context, SCHEMA_JSON);
    const critique = renderCritique(frozen, context, '{"targetId":"p1"}', SCHEMA_JSON);

    expect(critique.system.text).not.toBe(generate.system.text);
    expect(critique.user.text).toContain('投票决定放逐谁');
    expect(critique.user.text).toContain('{"targetId":"p1"}');
    expect(critique.user.text).not.toContain(generate.system.text);
  });

  it('质疑拿得到候选，不然「目标不在候选里」这一条没法判', async () => {
    const frozen = await localPrompts();
    const critique = renderCritique(frozen, context, '{"targetId":"p1"}', SCHEMA_JSON);

    expect(critique.user.text).toContain('1 号 p1');
  });

  it('修订带着上一版和审核意见一起给', async () => {
    const frozen = await localPrompts();
    const revise = renderRevise(
      frozen,
      context,
      '{"targetId":"p1"}',
      '目标不在候选里',
      SCHEMA_JSON,
    );

    expect(revise.user.text).toContain('{"targetId":"p1"}');
    expect(revise.user.text).toContain('目标不在候选里');
  });

  it('修订只要一次输出格式，不会同时要求「写成一段话」和 JSON', async () => {
    const frozen = await localPrompts();
    const revise = renderRevise(frozen, context, '草稿', '意见', SCHEMA_JSON);

    expect(revise.user.text).not.toContain('结果直接写成一段话');
    expect(revise.user.text.match(/结果按下面这个 JSON Schema 输出/g)).toHaveLength(1);
  });

  it('每段都记得住自己出自哪条模板、哪个来源', async () => {
    const frozen = await localPrompts();
    const turn = renderGenerate(frozen, context, SCHEMA_JSON);

    expect(turn.system.template).toBe(TURN_PROMPT_NAMES.generateSystem);
    expect(turn.user.template).toBe(TURN_PROMPT_NAMES.generateUser);
    expect(turn.system.source).toBe('local');
    expect(turn.system.version).toBeNull();
  });
});

describe('冻结一局的提示词', () => {
  it('平台取得到就用平台那份，正文与版本都跟着走', async () => {
    const platform: PromptSource = {
      async load(name) {
        const local = await LOCAL_TURN_PROMPTS.load(name);
        return { ...local, text: `${local.text}\n平台加的尾巴`, version: 7, source: 'platform' };
      },
    };

    const frozen = await freezeTurnPrompts(platform);

    expect(frozen[TURN_PROMPT_NAMES.generateUser].source).toBe('platform');
    expect(frozen[TURN_PROMPT_NAMES.generateUser].version).toBe(7);
    expect(renderGenerate(frozen, context, null).user.text).toContain('平台加的尾巴');
  });

  it('平台有一条取不到，整局换本地兜底，不半局平台半局本地', async () => {
    const half: PromptSource = {
      async load(name) {
        if (name === TURN_PROMPT_NAMES.critiqueUser) throw new Error('这条没了');
        return { name, text: '平台正文', version: 3, source: 'platform' };
      },
    };

    const frozen = await freezeTurnPrompts(half);

    for (const name of TURN_PROMPT_NAMES_ALL) {
      expect(frozen[name].source).toBe('local');
      expect(frozen[name].version).toBeNull();
    }
  });

  it('平台上的模板被改得缺了必需变量，当场抛，不回退', async () => {
    const broken: PromptSource = {
      async load(name) {
        return { name, text: '这段里什么变量都没有', version: 1, source: 'platform' };
      },
    };

    await expect(freezeTurnPrompts(broken)).rejects.toMatchObject({
      name: 'PromptContractError',
    });
  });
});
