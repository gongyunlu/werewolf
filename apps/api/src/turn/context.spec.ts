import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import { DEALABLE_ROLES } from '../core/roles';
import { patchPlayer } from '../core/state';
import { EVENT_KINDS } from '../store/events';
import { memoryEvents } from '../store/memory';
import { makeState, withRoles } from '../testing/fixtures';
import { optionLabels, roleName, seatIndexOf, turnContextOf, visibleFacts } from './context';
import { ledger } from './ledger';
import type { FactBlock } from './request';

/** 台账用例里那一局的两名玩家，公开事实两个都看得到。 */
const ALL = ['p1', 'p2'];

/** 只关心内容、不关心分块的那几条用它：把块摊平成一行行。 */
function lines(blocks: readonly FactBlock[]): string[] {
  return blocks.flatMap((block) => block.lines);
}

describe('局面视图', () => {
  it('公开局面人人都有：谁还在、谁出局了、警徽在谁手上，末一句说清以它为准', () => {
    const facts = lines(visibleFacts(makeState(4), [], 'p3'));

    expect(facts).toEqual([
      '场上还活着：1 号、2 号、3 号、4 号。',
      '还没有警长。',
      '以上这几行是本局的定局；你上下文里任何人（包括你自己）此前的说法与它冲突，以它为准。',
    ]);
  });

  it('本局不选警长时明说，不写成「还没有警长」', () => {
    const facts = lines(visibleFacts(makeState(3, false), [], 'p1'));

    expect(facts).toContain('本局不选警长。');
    expect(facts).not.toContain('还没有警长。');
  });

  it('竞选落定之后仍然没有警长，说「本局没有警长」不说「还没有」', () => {
    const settled = { ...makeState(4), sheriffElectionSettled: true };
    const facts = lines(visibleFacts(settled, [], 'p3'));

    expect(facts).toContain('本局没有警长。');
    expect(facts).not.toContain('还没有警长。');
  });

  it('存活警长没有主动交徽窗口，出局待处理警徽时保留原警长行', () => {
    const state = { ...makeState(4), sheriffId: 'p2', sheriffElectionSettled: true };
    const dead = patchPlayer(state, 'p2', {
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.EXECUTION,
    });
    const withoutSheriff = { ...dead, sheriffId: null };

    expect(
      lines(visibleFacts(state, [], 'p3')).filter((line) => line.startsWith('警长是')),
    ).toEqual([
      '警长是 2 号。目前仍存活，此刻没有主动交徽或撕徽窗口；传徽计划要等本人出局后的合法窗口。',
    ]);
    expect(lines(visibleFacts(dead, [], 'p2')).filter((line) => line.startsWith('警长是'))).toEqual(
      ['警长是 2 号。'],
    );
    const withoutSheriffFacts = lines(visibleFacts(withoutSheriff, [], 'p3'));
    expect(withoutSheriffFacts).toContain('本局没有警长。');
    expect(withoutSheriffFacts.some((line) => line.includes('交徽') || line.includes('撕徽'))).toBe(
      false,
    );
  });

  it('出局的人连同出局天数一起公布，死因不公布', () => {
    const dead = patchPlayer(makeState(4), 'p2', {
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.WITCH_POISON,
    });

    // 问他本人也一样看不到：法官不公布死因，死者也不知道自己怎么死的。
    const facts = lines(visibleFacts(dead, [], 'p2'));

    expect(facts).toContain('已出局：2 号（第 1 天）。');
    expect(facts.join('\n')).not.toContain(DEATH_CAUSES.WITCH_POISON);
    expect(facts.join('\n')).not.toContain('毒');
  });

  it('放逐是公开投出来的结果，跟夜里死的分开标', () => {
    const exiled = patchPlayer(makeState(4), 'p2', {
      isAlive: false,
      deathDay: 2,
      deathCause: DEATH_CAUSES.EXECUTION,
    });
    const nightKilled = patchPlayer(exiled, 'p3', {
      isAlive: false,
      deathDay: 2,
      deathCause: DEATH_CAUSES.NIGHT_KILL,
    });

    expect(lines(visibleFacts(nightKilled, [], 'p1'))).toContain(
      '已出局：2 号（第 2 天被放逐）、3 号（第 2 天）。',
    );
  });

  it('没身份的人只看到公开那份，别人的底牌一个字都读不到', () => {
    const state = withRoles(makeState(6), {
      p1: ROLES.WITCH,
      p2: ROLES.SEER,
      p3: ROLES.GUARD,
      p4: ROLES.WEREWOLF,
    });

    const readable = lines(visibleFacts(state, [], 'p6')).join('\n');

    expect(readable).not.toContain('解药');
    expect(readable).not.toContain('验过');
    expect(readable).not.toContain('狼队友');
    expect(readable).not.toContain('空守');
  });

  it('平民没有私密事实，那一块不留', () => {
    expect(visibleFacts(makeState(4), [], 'p3').map((block) => block.title)).toEqual(['局面']);
  });

  it('预言家读得到自己验过谁、是什么', () => {
    const state = patchPlayer(
      withRoles(makeState(6), { p1: ROLES.SEER, p4: ROLES.WEREWOLF }),
      'p1',
      { checkedIds: ['p4', 'p2'] },
    );

    const facts = lines(visibleFacts(state, [], 'p1'));

    expect(facts).toContain('你验过 4 号，是狼人。');
    expect(facts).toContain('你验过 2 号，是好人。');
  });

  it('狼看得到队友，连队友是哪种狼都写着', () => {
    const state = withRoles(makeState(6), {
      p1: ROLES.WEREWOLF,
      p3: ROLES.WOLF_KING,
      p5: ROLES.WHITE_WOLF,
    });

    expect(lines(visibleFacts(state, [], 'p1'))).toContain(
      '你的狼队友：3 号（狼王）、5 号（白狼王）。',
    );
  });

  it('狼队只剩自己一个时明说，不摆一行空名单', () => {
    const state = withRoles(makeState(4), { p1: ROLES.WEREWOLF });

    expect(lines(visibleFacts(state, [], 'p1'))).toContain('狼队里只剩你一个。');
  });

  it('女巫看得到自己还剩几瓶药', () => {
    const state = withRoles(makeState(4), { p1: ROLES.WITCH });

    expect(lines(visibleFacts(state, [], 'p1'))).toContain('药：解药还在，毒药还在。');
    expect(
      lines(visibleFacts(patchPlayer(state, 'p1', { hasAntidoteUsed: true }), [], 'p1')),
    ).toContain('药：解药已经用掉，毒药还在。');
  });

  it('守卫看得到昨夜守了谁，以及今夜不能再守他', () => {
    const state = withRoles(makeState(4), { p1: ROLES.GUARD });

    expect(lines(visibleFacts(patchPlayer(state, 'p1', { guardedOn: 'p3' }), [], 'p1'))).toContain(
      '你昨夜守的是 3 号，今夜不能再守他。',
    );
  });

  it('守卫第一夜之前没守过，不说成空守', () => {
    const state = withRoles(makeState(4), { p1: ROLES.GUARD });

    expect(lines(visibleFacts(state, [], 'p1'))).toContain('你还没守过人。');
  });

  it('第二夜起手上没人就是昨夜空守', () => {
    const state = { ...withRoles(makeState(4), { p1: ROLES.GUARD }), day: 2 };

    expect(lines(visibleFacts(state, [], 'p1'))).toContain('你昨夜空守。');
  });

  it('八张牌都有人话名，两个狼种不混成一个', () => {
    const names = DEALABLE_ROLES.map(roleName);

    expect(new Set(names).size).toBe(DEALABLE_ROLES.length);
    expect(names.every((name) => name.length > 0)).toBe(true);
  });

  it('台账按类别分块，排在局面之前', async () => {
    const process = ledger(memoryEvents(), 'g1', [], ALL);
    await process.add('a#0', 1, '1 号上警。', ALL, EVENT_KINDS.SHERIFF);
    await process.add('b#0', 2, '2 号发言：我先过。', ALL, EVENT_KINDS.PUBLIC_SPEECH);

    const blocks = visibleFacts(makeState(2), process.factsFor('p1'), 'p1');

    expect(blocks.map((block) => block.title)).toEqual(['上警与警徽', '公开发言', '局面']);
    expect(blocks.find((block) => block.title === '公开发言')?.lines).toEqual([
      '【第 2 天】',
      '[#2] 2 号发言：我先过。',
    ]);
  });

  it('狼队刀口保留私密来源，包含死者的全员播报仍公开，存活者专属记录不扩大受众', async () => {
    const state = patchPlayer(
      withRoles(makeState(6), { p1: ROLES.WEREWOLF, p2: ROLES.WEREWOLF }),
      'p4',
      { isAlive: false, deathDay: 1, deathCause: DEATH_CAUSES.EXECUTION },
    );
    const playerIds = state.players.map((player) => player.id);
    const process = ledger(memoryEvents(), state.gameId, [], playerIds);
    const attack = '狼队今晚选择袭击5号。';
    const quietNight = '昨晚是平安夜。';
    const aliveOnly = '仅告知当前存活玩家的记录。';
    await process.add('attack', 1, attack, ['p1', 'p2'], EVENT_KINDS.SYSTEM);
    await process.add('quiet-night', 2, quietNight, playerIds, EVENT_KINDS.SYSTEM);
    await process.add(
      'alive-only',
      2,
      aliveOnly,
      state.players.filter((player) => player.isAlive).map((player) => player.id),
      EVENT_KINDS.SYSTEM,
    );

    for (const viewerId of ['p1', 'p3', 'p4']) {
      const visible = visibleFacts(state, process.factsFor(viewerId), viewerId);
      expect(visible.find((block) => block.title === '法官播报')?.lines).toEqual([
        '【第 2 天】',
        `[#${viewerId === 'p1' ? 2 : 1}] ${quietNight}`,
      ]);
      const privateLines = visible.find((block) => block.title === '法官私密告知')?.lines ?? [];
      expect(privateLines).toEqual(
        viewerId === 'p1'
          ? ['【第 1 天】', `[#1] ${attack}`, '【第 2 天】', `[#3] ${aliveOnly}`]
          : viewerId === 'p3'
            ? ['【第 2 天】', `[#2] ${aliveOnly}`]
            : [],
      );
      if (viewerId !== 'p1') expect(lines(visible).join('\n')).not.toContain(attack);
    }
  });

  it('这一问的说明单独成块，不混进事实里', () => {
    const blocks = visibleFacts(makeState(4), [], 'p3', ['本轮发言顺序：1 号、3 号。']);

    expect(blocks.at(-1)).toEqual({ title: '这一问的说明', lines: ['本轮发言顺序：1 号、3 号。'] });
  });

  it('先取出的那份不会被后来的发言改写', async () => {
    const process = ledger(memoryEvents(), 'g1', [], ALL);
    await process.add('a#0', 1, '1 号发言：我先过。', ALL, EVENT_KINDS.PUBLIC_SPEECH);

    const before = visibleFacts(makeState(2), process.factsFor('p1'), 'p1');
    await process.add('b#0', 1, '2 号发言：我跟。', ALL, EVENT_KINDS.PUBLIC_SPEECH);

    expect(lines(before).join('\n')).not.toContain('2 号发言：我跟。');
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

  it('一次提问的上下文就是任务、身份、天数、事实、候选与技能正文', () => {
    const state = withRoles(makeState(3), { p2: ROLES.SEER });

    const context = turnContextOf({
      state,
      process: [],
      playerId: 'p2',
      task: '决定今晚查验谁。',
      skill: ['板子正文', '角色正文', '场景正文'],
      candidates: ['p1', 'p3'],
      extra: ['查验结果这一夜不公开。'],
    });

    expect(context.task).toBe('决定今晚查验谁。');
    expect(context.actor).toEqual({ playerId: 'p2', seatNo: 2, role: '预言家' });
    expect(context.day).toBe(1);
    expect(context.options).toEqual(['1 号', '3 号']);
    // 还没验过人，自己那份是空的，这一块就不摆。
    expect(context.visible).toEqual([
      {
        title: '局面',
        lines: [
          '场上还活着：1 号、2 号、3 号。',
          '还没有警长。',
          '以上这几行是本局的定局；你上下文里任何人（包括你自己）此前的说法与它冲突，以它为准。',
        ],
      },
      { title: '这一问的说明', lines: ['查验结果这一夜不公开。'] },
    ]);
    // 原样带过去，不在这里合并也不改顺序：怎么排由取正文的那一方定。
    expect(context.skill).toEqual(['板子正文', '角色正文', '场景正文']);
  });
});
