import { scriptedActions, type ScriptedAnswers } from './actions';

function answersOf(overrides: Partial<ScriptedAnswers> = {}): ScriptedAnswers {
  return {
    candidacy: {},
    withdrawal: {},
    speech: {},
    ballot: {},
    speechSide: {},
    badge: {},
    ...overrides,
  };
}

describe('脚本行动提供者', () => {
  it('上警与退水按玩家 id 作答', async () => {
    const actions = scriptedActions(
      answersOf({ candidacy: { p1: true, p2: false }, withdrawal: { p1: false } }),
    );

    expect(await actions.runForSheriff('p1')).toBe(true);
    expect(await actions.runForSheriff('p2')).toBe(false);
    expect(await actions.withdraw('p1')).toBe(false);
  });

  it('发言与投票按轮次再按玩家 id 作答', async () => {
    const actions = scriptedActions(
      answersOf({
        speech: { campaign: { p1: '我上警' }, campaign_pk: { p1: '再说一次' } },
        ballot: { exile: { p1: 'p2' }, exile_pk: { p1: 'p3' } },
      }),
    );

    expect(await actions.speak('campaign', 'p1')).toBe('我上警');
    expect(await actions.speak('campaign_pk', 'p1')).toBe('再说一次');
    expect(await actions.vote('exile', 'p1', ['p2', 'p3'])).toBe('p2');
    expect(await actions.vote('exile_pk', 'p1', ['p3'])).toBe('p3');
  });

  it('弃票是一个配得出来的答案', async () => {
    const actions = scriptedActions(answersOf({ ballot: { exile: { p1: null } } }));

    expect(await actions.vote('exile', 'p1', ['p2'])).toBeNull();
  });

  it('发言方向按天数作答', async () => {
    const actions = scriptedActions(answersOf({ speechSide: { '1': 'left', '2': 'right' } }));

    expect(await actions.chooseSpeechSide('p1', 1)).toBe('left');
    expect(await actions.chooseSpeechSide('p1', 2)).toBe('right');
  });

  it('警徽去向按警长作答', async () => {
    const actions = scriptedActions(
      answersOf({ badge: { p1: { kind: 'transfer', toId: 'p2' }, p3: { kind: 'tear' } } }),
    );

    expect(await actions.decideBadge('p1', ['p2'])).toEqual({ kind: 'transfer', toId: 'p2' });
    expect(await actions.decideBadge('p3', ['p2'])).toEqual({ kind: 'tear' });
  });

  it('没配过的行动一律抛错，不拿默认值顶上', async () => {
    // 「没配」和「配了 false」「配了弃票」必须分得开：前者是用例漏写剧本，
    // 后者才是这名玩家的真实决定。
    const actions = scriptedActions(answersOf());

    await expect(actions.runForSheriff('p1')).rejects.toThrow('脚本缺少回答：p1 是否上警');
    await expect(actions.withdraw('p1')).rejects.toThrow('脚本缺少回答：p1 是否退水');
    await expect(actions.speak('campaign', 'p1')).rejects.toThrow(
      '脚本缺少回答：campaign 轮 p1 的发言',
    );
    await expect(actions.vote('exile', 'p1', [])).rejects.toThrow(
      '脚本缺少回答：exile 轮 p1 的投票',
    );
    await expect(actions.chooseSpeechSide('p1', 1)).rejects.toThrow('脚本缺少回答');
    await expect(actions.decideBadge('p1', [])).rejects.toThrow('脚本缺少回答');
  });

  it('配了轮次但漏了人，也只缺那一个人', async () => {
    const actions = scriptedActions(answersOf({ ballot: { exile: { p1: 'p2' } } }));

    expect(await actions.vote('exile', 'p1', ['p2'])).toBe('p2');
    await expect(actions.vote('exile', 'p2', ['p2'])).rejects.toThrow(
      '脚本缺少回答：exile 轮 p2 的投票',
    );
  });
});
