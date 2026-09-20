import type { ModelCapability } from '../llm/model-capability';
import type { PromptTemplate } from '../llm/prompt-template';
import { TURN_PROMPT_NAMES, TURN_PROMPT_NAMES_ALL } from './prompt';
import { decisionInputHash, type DecisionHashSource } from './snapshot';

const CAPABILITY: ModelCapability = {
  allowCodeFence: false,
  reasoningOff: null,
};

/** 整局冻住的那六条。这里只验哈希，正文是不是真模板不重要，六条齐全就行。 */
const PROMPTS: readonly PromptTemplate[] = TURN_PROMPT_NAMES_ALL.map((name) => ({
  name,
  text: `${name} 的正文`,
  version: 1,
  source: 'platform',
}));

/** 把生成那一条换掉，其余不动。 */
function withGenerate(changes: Partial<PromptTemplate>): readonly PromptTemplate[] {
  return PROMPTS.map((prompt) =>
    prompt.name === TURN_PROMPT_NAMES.generateUser ? { ...prompt, ...changes } : prompt,
  );
}

function source(overrides: Partial<DecisionHashSource> = {}): DecisionHashSource {
  return {
    actionKey: '["g1","node/3/vote","vote","p3",0]',
    actionType: 'vote',
    actionOrdinal: 0,
    preset: 'quick',
    model: '用例模型',
    capability: CAPABILITY,
    context: {
      task: '投票决定放逐谁。',
      actor: { playerId: 'p3', seatNo: 3, role: '预言家' },
      day: 2,
      visible: ['1 号昨天跳了预言家'],
      options: ['1 号 p1', '2 号 p2'],
    },
    schema: { type: 'object' },
    prompts: PROMPTS,
    ...overrides,
  };
}

describe('冻结输入哈希', () => {
  it('同一份输入算出同一个值', () => {
    expect(decisionInputHash(source())).toBe(decisionInputHash(source()));
    expect(decisionInputHash(source())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('换个档位就算另一次输入', () => {
    expect(decisionInputHash(source({ preset: 'quality' }))).not.toBe(decisionInputHash(source()));
  });

  it('局面、序号、行动键有一个不同，哈希就不同', () => {
    const base = decisionInputHash(source());
    const changed: Partial<DecisionHashSource>[] = [
      { actionOrdinal: 1 },
      { actionKey: '["g1","node/3/vote","vote","p3",1]' },
      { schema: { type: 'string' } },
      { capability: { ...CAPABILITY, allowCodeFence: true } },
      // 能力声明一样的两个型号是两台不同的机器，同一个输入答出来的东西不一样。
      { model: '另一个模型' },
      // 正文改了哈希就得变——版本号只是标记，正文才是真正的输入。
      { prompts: withGenerate({ text: '改过的正文' }) },
      { prompts: withGenerate({ version: 2 }) },
      { context: { ...source().context, day: 3 } },
    ];

    for (const override of changed) {
      expect(decisionInputHash(source(override))).not.toBe(base);
    }
  });

  it('输入对象的键序不影响哈希', () => {
    const shuffled = { ...source().context };
    const reordered = {
      options: shuffled.options,
      day: shuffled.day,
      visible: shuffled.visible,
      actor: {
        role: shuffled.actor.role,
        seatNo: shuffled.actor.seatNo,
        playerId: shuffled.actor.playerId,
      },
      task: shuffled.task,
    };

    expect(decisionInputHash(source({ context: reordered }))).toBe(decisionInputHash(source()));
  });
});
