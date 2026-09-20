import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import { DEALABLE_ROLES } from '../core/roles';
import { patchPlayer } from '../core/state';
import { makeState, withRoles } from '../testing/fixtures';
import { optionLabels, roleName, seatIndexOf, turnContextOf, visibleFacts } from './context';
import { ledger } from './ledger';

/** 空台账，用例只关心局面那部分时用它。 */
function noProcess() {
  return ledger();
}

describe('局面视图', () => {
  it('公开局面人人都有：谁还在、谁出局了、警徽在谁手上', () => {
    const facts = visibleFacts(makeState(4), noProcess(), 'p3');

    expect(facts).toEqual(['场上还活着：1 号、2 号、3 号、4 号。', '还没有警长。']);
  });

  it('本局不选警长时明说，不写成「还没有警长」', () => {
    const facts = visibleFacts(makeState(3, false), noProcess(), 'p1');

    expect(facts).toContain('本局不选警长。');
    expect(facts).not.toContain('还没有警长。');
  });

  it('出局的人连同出局天数一起公布，死因不公布', () => {
    const dead = patchPlayer(makeState(4), 'p2', {
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.WITCH_POISON,
    });

    // 问他本人也一样看不到：法官不公布死因，死者也不知道自己怎么死的。
    const facts = visibleFacts(dead, noProcess(), 'p2');
    const lines = facts.join('\n');

    expect(facts).toContain('已出局：2 号（第 1 天）。');
    expect(lines).not.toContain(DEATH_CAUSES.WITCH_POISON);
    expect(lines).not.toContain('毒');
  });

  it('没身份的人只看到公开那份，别人的底牌一个字都读不到', () => {
    const state = withRoles(makeState(6), {
      p1: ROLES.WITCH,
      p2: ROLES.SEER,
      p3: ROLES.GUARD,
      p4: ROLES.WEREWOLF,
    });

    const lines = visibleFacts(state, noProcess(), 'p6').join('\n');

    expect(lines).not.toContain('解药');
    expect(lines).not.toContain('验过');
    expect(lines).not.toContain('狼队友');
    expect(lines).not.toContain('空守');
  });

  it('预言家读得到自己验过谁、是什么', () => {
    const state = patchPlayer(
      withRoles(makeState(6), { p1: ROLES.SEER, p4: ROLES.WEREWOLF }),
      'p1',
      { checkedIds: ['p4', 'p2'] },
    );

    const facts = visibleFacts(state, noProcess(), 'p1');

    expect(facts).toContain('你验过 4 号，是狼人。');
    expect(facts).toContain('你验过 2 号，是好人。');
  });

  it('狼看得到队友，连队友是哪种狼都写着', () => {
    const state = withRoles(makeState(6), {
      p1: ROLES.WEREWOLF,
      p3: ROLES.WOLF_KING,
      p5: ROLES.WHITE_WOLF,
    });

    expect(visibleFacts(state, noProcess(), 'p1')).toContain(
      '你的狼队友：3 号（狼王）、5 号（白狼王）。',
    );
  });

  it('狼队只剩自己一个时明说，不摆一行空名单', () => {
    const state = withRoles(makeState(4), { p1: ROLES.WEREWOLF });

    expect(visibleFacts(state, noProcess(), 'p1')).toContain('狼队里只剩你一个。');
  });

  it('女巫看得到自己还剩几瓶药', () => {
    const state = withRoles(makeState(4), { p1: ROLES.WITCH });

    expect(visibleFacts(state, noProcess(), 'p1')).toContain('药：解药还在，毒药还在。');
    expect(
      visibleFacts(patchPlayer(state, 'p1', { hasAntidoteUsed: true }), noProcess(), 'p1'),
    ).toContain('药：解药已经用掉，毒药还在。');
  });

  it('守卫看得到昨夜守了谁，以及今夜不能再守他', () => {
    const state = withRoles(makeState(4), { p1: ROLES.GUARD });

    expect(
      visibleFacts(patchPlayer(state, 'p1', { guardedOn: 'p3' }), noProcess(), 'p1'),
    ).toContain('你昨夜守的是 3 号，今夜不能再守他。');
  });

  it('守卫第一夜之前没守过，不说成空守', () => {
    const state = withRoles(makeState(4), { p1: ROLES.GUARD });

    expect(visibleFacts(state, noProcess(), 'p1')).toContain('你还没守过人。');
  });

  it('第二夜起手上没人就是昨夜空守', () => {
    const state = { ...withRoles(makeState(4), { p1: ROLES.GUARD }), day: 2 };

    expect(visibleFacts(state, noProcess(), 'p1')).toContain('你昨夜空守。');
  });

  it('八张牌都有人话名，两个狼种不混成一个', () => {
    const names = DEALABLE_ROLES.map(roleName);

    expect(new Set(names).size).toBe(DEALABLE_ROLES.length);
    expect(names.every((name) => name.length > 0)).toBe(true);
  });

  it('台账接在局面之后，按发生顺序，换天插一行分隔', () => {
    const process = ledger();
    process.add(1, '1 号上警。');
    process.add(2, '2 号发言：我先过。');

    expect(visibleFacts(makeState(2), process, 'p1').slice(-4)).toEqual([
      '【第 1 天】',
      '1 号上警。',
      '【第 2 天】',
      '2 号发言：我先过。',
    ]);
  });

  it('先取出的那份不会被后来的发言改写', () => {
    const process = ledger();
    process.add(1, '1 号发言：我先过。');

    const before = visibleFacts(makeState(2), process, 'p1');
    process.add(1, '2 号发言：我跟。');

    expect(before.join('\n')).not.toContain('2 号发言：我跟。');
  });

  it('候选渲染成座位号，跟决定形状里的取值集是同一批', () => {
    const index = seatIndexOf(makeState(5));

    expect(optionLabels(['p3', 'p5'], index)).toEqual(['3 号', '5 号']);
    expect(optionLabels([], index)).toEqual([]);
  });

  it('局外的 id 与座位号都当场抛', () => {
    const index = seatIndexOf(makeState(3));

    expect(() => index.toSeatNo('p9')).toThrow('局内没有 p9');
    expect(() => index.toPlayerId(9)).toThrow('局内没有 9 号座位');
  });

  it('一次提问的上下文就是任务、身份、天数、事实与候选', () => {
    const state = withRoles(makeState(3), { p2: ROLES.SEER });

    const context = turnContextOf({
      state,
      ledger: noProcess(),
      playerId: 'p2',
      task: '决定今晚查验谁。',
      candidates: ['p1', 'p3'],
      extra: ['查验结果这一夜不公开。'],
    });

    expect(context.task).toBe('决定今晚查验谁。');
    expect(context.actor).toEqual({ playerId: 'p2', seatNo: 2, role: '预言家' });
    expect(context.day).toBe(1);
    expect(context.options).toEqual(['1 号', '3 号']);
    expect(context.visible).toContain('查验结果这一夜不公开。');
  });
});
