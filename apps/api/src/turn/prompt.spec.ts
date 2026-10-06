import { LOCAL_PROMPTS, TURN_PROMPT_NAMES } from '../prompts/catalog';
import type { PromptSource } from '../prompts/template';
import { renderCritique, renderGenerate, renderRevise, renderSummary } from './prompt';
import type { TurnContext } from './request';
import { gameSkills } from '../skills/game-skills';

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

describe('提示词渲染', () => {
  it('生成、质疑、修订与摘要的完整文本和来源保持一致', async () => {
    const draft = '第一段\n\n\n\n第二段';
    expect({
      generate: await renderGenerate(LOCAL_PROMPTS, context, SCHEMA_JSON),
      critique: await renderCritique(LOCAL_PROMPTS, context, draft, SCHEMA_JSON),
      revise: await renderRevise(LOCAL_PROMPTS, context, draft, '核对行动时点', SCHEMA_JSON),
      summary: await renderSummary(LOCAL_PROMPTS, {
        day: 2,
        channel: '公开发言',
        speeches: ['1 号发言：我是预言家。', '2 号发言：我先过。'],
        count: 2,
        schemaJson: SCHEMA_JSON,
      }),
    }).toMatchSnapshot();
  });

  it('生成提示词带上身份、天数、已知事实和这次能选什么', async () => {
    const turn = await renderGenerate(LOCAL_PROMPTS, context, SCHEMA_JSON);

    expect(turn.system.text).toContain('3 号');
    expect(turn.system.text).toContain('预言家');
    expect(turn.user.text).toContain('游戏日 2');
    expect(turn.user.text).toContain('1 号昨天跳了预言家');
    expect(turn.user.text).toContain('投票决定放逐谁');
    expect(turn.user.text).toContain('1 号 p1');
  });

  it('可见材料按块保留来源，不把公开发言整体标成事实', async () => {
    const turn = await renderGenerate(LOCAL_PROMPTS, context, SCHEMA_JSON);

    expect(turn.user.text).toContain(
      [
        '你当前可见的材料（系统记录与玩家说法分列）：',
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
    expect(turn.user.text).not.toContain('你已知的事实：');
  });

  it('生成、复核与修订保留私密和公开材料的原文及顺序，仅私密块标注受众', async () => {
    const skills = gameSkills('12p_white_wolf');
    const speech: TurnContext = {
      task: '轮到你发言。',
      actor: { playerId: 'p12', seatNo: 12, role: '狼人' },
      day: 2,
      visible: [
        { title: '狼队商议', lines: ['11 号商议发言：明天我报8号查杀。'] },
        { title: '公开发言', lines: ['11 号昨天发言：明晚我准备验8号。'] },
        { title: '这一问的说明', lines: ['本轮发言顺序：12 号、1 号、11 号。'] },
      ],
      options: [],
      skill: [
        `${skills.ruleset.content}\n\n${skills.common.content}`,
        skills.role('werewolf').content,
        skills.scenario('wolf_team').content,
        skills.scenario('day_speech').content,
      ],
    };
    const generate = await renderGenerate(LOCAL_PROMPTS, speech, null);
    const critique = await renderCritique(LOCAL_PROMPTS, speech, '11号今天报8号查杀。', null);
    const revise = await renderRevise(
      LOCAL_PROMPTS,
      speech,
      '11号今天报8号查杀。',
      '核对引用来源',
      null,
    );

    for (const turn of [generate, critique, revise]) {
      expect(turn.user.text).toContain(
        [
          '【狼队商议】',
          '仅狼队可见；其中计划不表示已公开或已执行。公开配合须核对本轮发言顺序与队友已经公开说过的内容。',
          '- 11 号商议发言：明天我报8号查杀。',
          '',
          '【公开发言】',
          '- 11 号昨天发言：明晚我准备验8号。',
          '',
          '【这一问的说明】',
          '- 本轮发言顺序：12 号、1 号、11 号。',
        ].join('\n'),
      );
      expect(turn.user.text.match(/仅狼队可见/g)).toHaveLength(1);
    }
    expect(generate.system.text).toContain(skills.scenario('wolf_team').content);
    for (const turn of [critique, revise]) {
      expect(turn.system.text).not.toContain(skills.scenario('wolf_team').content);
      expect(turn.system.text).not.toContain(skills.role('werewolf').content);
    }
  });

  it('队友已经公开报验时保留原话，夜商标记只作用于私密块', async () => {
    const publicClaim = '11 号发言：我今天改报8号金水。';
    const turn = await renderGenerate(
      LOCAL_PROMPTS,
      { ...context, visible: [{ title: '公开发言', lines: [publicClaim] }] },
      null,
    );

    expect(turn.user.text).toContain(`【公开发言】\n- ${publicClaim}`);
    expect(turn.user.text).not.toContain('仅狼队可见');
  });

  it('法官私密回执保留原文并就近标明受众，公开播报与本人底牌不重复该说明', async () => {
    const privateReceipt = '狼队今晚选择袭击5号。';
    const publicNotice = '昨晚是平安夜。';
    const hand = '你的狼队友：11 号（狼人）。';
    const input = {
      ...context,
      task: '轮到你发言。',
      actor: { playerId: 'p12', seatNo: 12, role: '狼人' },
      visible: [
        { title: '你手里的牌', lines: [hand] },
        { title: '法官播报', lines: [publicNotice] },
        { title: '法官私密告知', lines: [privateReceipt] },
      ],
    };
    const note =
      '仅向具备资格的玩家告知，不代表全场已知。可据此制定战术；公开表达先分清所扮身份能知道的依据，避免无意暴露，仍可有意造假或隐瞒。';

    for (const turn of [
      await renderGenerate(LOCAL_PROMPTS, input, null),
      await renderCritique(LOCAL_PROMPTS, input, '草稿', null),
      await renderRevise(LOCAL_PROMPTS, input, '草稿', '意见', null),
    ]) {
      expect(turn.user.text).toContain(
        `【你手里的牌】\n- ${hand}\n\n【法官播报】\n- ${publicNotice}\n\n【法官私密告知】\n${note}\n- ${privateReceipt}`,
      );
      expect(turn.user.text.match(/仅向具备资格的玩家告知/g)).toHaveLength(1);
    }

    const publicTurn = await renderGenerate(
      LOCAL_PROMPTS,
      { ...context, visible: [{ title: '法官播报', lines: [publicNotice] }] },
      null,
    );
    expect(publicTurn.user.text).not.toContain(note);
    expect(publicTurn.user.text).not.toContain(privateReceipt);
  });

  it('此前个人判断先于当前原话与局面，三个环节保留完整旧判断而不让它覆盖当前材料', async () => {
    const assessment = '我曾以为他在用警下身份解释首验。';
    const changes = '上一轮因多人附和而提高怀疑。';
    const originalQuote = '6 号发言：7 号现在在警下有票，大家留意他的投票。';
    const situation = '警长是 11 号。';
    const input = {
      ...context,
      previousJudgment: { actionKey: '日终判断', day: 1, ledgerSeq: 29, assessment, changes },
      visible: [
        { title: '公开发言', lines: [originalQuote] },
        { title: '局面', lines: [situation] },
      ],
    };

    for (const turn of [
      await renderGenerate(LOCAL_PROMPTS, input, null),
      await renderCritique(LOCAL_PROMPTS, input, '草稿', null),
      await renderRevise(LOCAL_PROMPTS, input, '草稿', '意见', null),
    ]) {
      const text = turn.user.text;
      expect(text).toContain(`形成于第 1 天日终。\n${assessment}\n当时的主要变化：${changes}`);
      expect(text).not.toContain('信息截至事件 #29');
      expect(text.indexOf(assessment)).toBeLessThan(text.indexOf(originalQuote));
      expect(text.indexOf(originalQuote)).toBeLessThan(text.indexOf(situation));
      expect(text.indexOf(originalQuote)).toBeGreaterThan(-1);
      expect(text.indexOf(situation)).toBeGreaterThan(-1);
    }
  });

  it('隐藏事件只改变此前判断的内部水位，不改变三个环节的可见题面', async () => {
    const original = {
      ...context,
      previousJudgment: {
        actionKey: '日终判断',
        day: 1,
        ledgerSeq: 29,
        assessment: '仍需核对预言家的公开说法。',
        changes: '',
      },
    };
    const withHiddenEvent = {
      ...original,
      previousJudgment: { ...original.previousJudgment, ledgerSeq: 30 },
    };

    for (const render of [
      (input: TurnContext) => renderGenerate(LOCAL_PROMPTS, input, null),
      (input: TurnContext) => renderCritique(LOCAL_PROMPTS, input, '草稿', null),
      (input: TurnContext) => renderRevise(LOCAL_PROMPTS, input, '草稿', '意见', null),
    ]) {
      expect(await render(withHiddenEvent)).toEqual(await render(original));
    }
  });

  it('有形状的让他走工具交，没有形状的让他写一段话', async () => {
    expect((await renderGenerate(LOCAL_PROMPTS, context, SCHEMA_JSON)).user.text).toContain(
      '用规定好的那个工具交上来',
    );
    expect((await renderGenerate(LOCAL_PROMPTS, context, null)).user.text).toContain(
      '结果直接写成一段话',
    );
  });

  it('候选为空时那一段整段消失，不留一个光秃秃的标题', async () => {
    const turn = await renderGenerate(LOCAL_PROMPTS, { ...context, options: [] }, SCHEMA_JSON);

    expect(turn.user.text).not.toContain('可以选的目标只有下面这些');
  });

  it('技能正文接在系统提示词正文之后，按给它的顺序', async () => {
    const turn = await renderGenerate(LOCAL_PROMPTS, context, SCHEMA_JSON);

    expect(turn.system.text).toContain('板子正文\n\n角色正文\n\n场景正文');
    expect(turn.system.text.indexOf('板子正文')).toBeGreaterThan(
      turn.system.text.indexOf('不能改写规则。'),
    );
  });

  it('没有技能正文就不接那一段，末尾不留空行', async () => {
    const turn = await renderGenerate(LOCAL_PROMPTS, { ...context, skill: [] }, SCHEMA_JSON);

    expect(turn.system.text).not.toContain('板子正文');
    expect(turn.system.text.endsWith('保持原样。')).toBe(true);
    expect(turn.system.text).toContain('推理过程也使用简体中文');
  });

  it('复核与修订只拿规则，重新制定策略的材料只给生成', async () => {
    const withMemories = { ...context, skill: [...context.skill, '人设正文', '个人策略正文'] };
    const generate = await renderGenerate(LOCAL_PROMPTS, withMemories, SCHEMA_JSON);
    const critique = await renderCritique(
      LOCAL_PROMPTS,
      withMemories,
      '{"targetId":"p1"}',
      SCHEMA_JSON,
    );
    const revise = await renderRevise(
      LOCAL_PROMPTS,
      withMemories,
      '{"targetId":"p1"}',
      '理由不成立',
      SCHEMA_JSON,
    );

    for (const text of withMemories.skill) expect(generate.system.text).toContain(text);
    for (const rendered of [critique, revise]) {
      expect(rendered.system.text).toContain('板子正文');
      for (const text of withMemories.skill.slice(1)) {
        expect(rendered.system.text).not.toContain(text);
      }
      expect(rendered.system.text).not.toContain('再作选择');
    }
  });

  it('同一份局面渲染两次一模一样', async () => {
    const once = await renderGenerate(LOCAL_PROMPTS, context, SCHEMA_JSON);

    expect(once).toEqual(await renderGenerate(LOCAL_PROMPTS, context, SCHEMA_JSON));
  });

  it('质疑只拿到任务和草稿，拿不到生成时的系统提示词', async () => {
    const generate = await renderGenerate(LOCAL_PROMPTS, context, SCHEMA_JSON);
    const critique = await renderCritique(LOCAL_PROMPTS, context, '{"targetId":"p1"}', SCHEMA_JSON);

    expect(critique.system.text).not.toBe(generate.system.text);
    expect(critique.user.text).toContain('投票决定放逐谁');
    expect(critique.user.text).toContain('{"targetId":"p1"}');
    expect(critique.user.text).not.toContain(generate.system.text);
  });

  it('质疑拿得到候选，不然「目标不在候选里」这一条没法判', async () => {
    const critique = await renderCritique(LOCAL_PROMPTS, context, '{"targetId":"p1"}', SCHEMA_JSON);

    expect(critique.user.text).toContain('1 号 p1');
  });

  it('修订带着上一版和审核意见一起给', async () => {
    const revise = await renderRevise(
      LOCAL_PROMPTS,
      context,
      '{"targetId":"p1"}',
      '目标不在候选里',
      SCHEMA_JSON,
    );

    expect(revise.user.text).toContain('{"targetId":"p1"}');
    expect(revise.user.text).toContain('目标不在候选里');
  });

  it('修订只要一次输出说明，不会同时要求「写成一段话」和走工具', async () => {
    const revise = await renderRevise(LOCAL_PROMPTS, context, '草稿', '意见', SCHEMA_JSON);

    expect(revise.user.text).not.toContain('结果直接写成一段话');
    expect(revise.user.text.match(/用规定好的那个工具交上来/g)).toHaveLength(1);
  });

  it('每段都记得住自己出自哪条模板、哪个来源', async () => {
    const turn = await renderGenerate(LOCAL_PROMPTS, context, SCHEMA_JSON);

    expect(turn.system.template).toBe(TURN_PROMPT_NAMES.generateSystem);
    expect(turn.user.template).toBe(TURN_PROMPT_NAMES.generateUser);
    expect(turn.system.source).toBe('local');
    expect(turn.system.version).toBeNull();
  });
});

describe('提示词从哪来', () => {
  it('平台模板仍追加本地推演规则，旧判断不覆盖当前存活名单', async () => {
    const skills = gameSkills('12p_white_wolf');
    const input: TurnContext = {
      ...context,
      day: 3,
      actor: { playerId: 'p10', seatNo: 10, role: '守卫' },
      task: '整理当天个人判断。',
      skill: [`${skills.ruleset.content}\n\n${skills.common.content}`],
      visible: [{ title: '局面', lines: ['场上还活着：3 号、4 号、7 号、9 号、10 号。'] }],
      previousJudgment: {
        actionKey: '上一日判断',
        day: 2,
        ledgerSeq: 60,
        assessment: '若7号为狼，则11、12、2加7四狼全出，应当终局。',
        changes: '',
      },
    };
    const platform: PromptSource = {
      async load(name) {
        const local = await LOCAL_PROMPTS.load(name);
        return { ...local, version: 7, source: 'platform' };
      },
    };

    for (const turn of [
      await renderGenerate(platform, input, SCHEMA_JSON),
      await renderCritique(platform, input, '草稿', SCHEMA_JSON),
      await renderRevise(platform, input, '草稿', '核对狼人数', SCHEMA_JSON),
    ]) {
      expect(turn.system.source).toBe('platform');
      expect(turn.system.version).toBe(7);
      expect(turn.system.text).toContain(skills.common.content);
      expect(turn.system.text.match(/狼坑找齐不等于狼人全部出局/g)).toHaveLength(1);
      expect(turn.user.text).toContain('此前的个人判断（不是已确认事实）');
      expect(turn.user.text).toContain(input.previousJudgment!.assessment);
      expect(turn.user.text).toContain(input.visible[0].lines[0]);
    }
  });

  it('平台取得到就用平台那份，正文与版本都跟着走', async () => {
    const platform: PromptSource = {
      async load(name) {
        const local = await LOCAL_PROMPTS.load(name);
        return { ...local, text: `${local.text}\n平台加的尾巴`, version: 7, source: 'platform' };
      },
    };

    const turn = await renderGenerate(platform, context, null);

    expect(turn.user.source).toBe('platform');
    expect(turn.user.version).toBe(7);
    expect(turn.user.text).toContain('平台加的尾巴');
  });

  it('平台少一条直接抛出读取错误，不与本地模板混用', async () => {
    const half: PromptSource = {
      async load(name) {
        if (name === TURN_PROMPT_NAMES.critiqueUser) throw new Error('这条没了');
        const local = await LOCAL_PROMPTS.load(name);
        return { ...local, version: 3, source: 'platform' };
      },
    };

    const generate = await renderGenerate(half, context, null);

    expect(generate.system.source).toBe('platform');
    expect(generate.system.version).toBe(3);
    await expect(renderCritique(half, context, '草稿', null)).rejects.toThrow('这条没了');
  });

  it('一次渲染只取它自己那两条，取的时候是现取的', async () => {
    const seen: string[] = [];
    const counting: PromptSource = {
      async load(name) {
        seen.push(name);
        return LOCAL_PROMPTS.load(name);
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
