import { DEATH_CAUSES, ROLES, SEER_CHECK_RESULTS } from '@werewolf/shared';
import { makeState, playerOf, stubActions, withRoles } from '../../testing/fixtures';
import { announceDay } from '../day/announce';
import { patchPlayer, type GameState } from '../state';
import { runNight } from './run-night';
import type { FlowEvent } from '../flow';

/** 六人局：p1 狼人、p2 守卫、p3 女巫、p4 预言家，p5、p6 平民。 */
function board(): GameState {
  return withRoles(makeState(6), {
    p1: ROLES.WEREWOLF,
    p2: ROLES.GUARD,
    p3: ROLES.WITCH,
    p4: ROLES.SEER,
  });
}

/** 一抽签就炸的随机源，这些用例不该走到并列。 */
function noLottery(): never {
  throw new Error('没有人并列时不该抽签');
}

describe('走完一夜', () => {
  it('先睁眼再行动，结果只给对应角色，闭眼播报不透露角色是否存活', async () => {
    const events: FlowEvent[] = [];
    const actions = stubActions({
      wolfProposal: async () => 'p5',
      guardProtect: async () => 'p5',
      witchDecision: async () => ({ kind: 'none' }),
      seerCheck: async () => {
        expect(events.at(-1)?.key).toBe('seer-open');
        return 'p1';
      },
    });
    await runNight({
      state: board(),
      actions,
      random: noLottery,
      onFlow: async (_state, event) => {
        events.push(event);
      },
    });
    expect(events.map((event) => event.key)).toEqual([
      'night-start',
      'wolves-open',
      'wolves-result',
      'wolves-close',
      'guard-open',
      'guard-result',
      'guard-close',
      'witch-open',
      'witch-target',
      'witch-result',
      'witch-close',
      'seer-open',
      'seer-result',
      'seer-close',
    ]);
    expect(events.find((event) => event.key === 'seer-result')).toMatchObject({
      audience: ['p4'],
      text: '查验结果：1 号 是狼人。',
    });
    expect(events.find((event) => event.key === 'witch-target')?.audience).toEqual(['p3']);
    const deadSeer = patchPlayer(board(), 'p4', { isAlive: false });
    events.length = 0;
    await runNight({
      state: deadSeer,
      actions,
      random: noLottery,
      onFlow: async (_state, event) => {
        events.push(event);
      },
    });
    expect(events.some((event) => event.key === 'seer-open')).toBe(true);
    expect(events.some((event) => event.key === 'seer-close')).toBe(true);
    expect(events.some((event) => event.key === 'seer-result')).toBe(false);
  });

  it('四步串成一条线：狼刀、守护、用药、查验', async () => {
    const state = board();
    const actions = stubActions({
      wolfProposal: async () => 'p5',
      guardProtect: async () => 'p5',
      witchDecision: async () => ({ kind: 'none' }),
      seerCheck: async () => 'p1',
    });

    const result = await runNight({ state, actions, random: noLottery });

    // 守卫守住了刀口，今晨平安。
    expect(result.deaths).toEqual([]);
    expect(result.check).toEqual({ targetId: 'p1', result: SEER_CHECK_RESULTS.WEREWOLF });
    expect(playerOf(result.state, 'p2').guardedOn).toBe('p5');
    expect(result.state.players.every((player) => player.isAlive)).toBe(true);
  });

  it('守卫与女巫同时护住一个人，反而把他送走', async () => {
    const state = board();
    const actions = stubActions({
      wolfProposal: async () => 'p5',
      guardProtect: async () => 'p5',
      witchDecision: async () => ({ kind: 'antidote' }),
      seerCheck: async () => 'p1',
    });

    const result = await runNight({ state, actions, random: noLottery });

    expect(result.deaths).toEqual([{ playerId: 'p5', cause: DEATH_CAUSES.DOUBLE_SAVE }]);
    expect(playerOf(result.state, 'p3').hasAntidoteUsed).toBe(true);
  });

  it('女巫看到的刀口就是今晚狼刀落的地方，救中就是平安夜', async () => {
    const state = board();
    const seen: (string | null)[] = [];
    const actions = stubActions({
      wolfProposal: async () => 'p5',
      guardProtect: async () => null,
      witchDecision: async (_witchId, killTargetId) => {
        seen.push(killTargetId);
        return { kind: 'antidote' };
      },
      seerCheck: async () => 'p1',
    });

    const result = await runNight({ state, actions, random: noLottery });

    expect(seen).toEqual(['p5']);
    expect(result.deaths).toEqual([]);
  });

  it('刀口正是女巫本人时她看得到刀口，但不能自救，照样睁眼用毒', async () => {
    const state = board();
    const seen: (string | null)[] = [];
    const actions = stubActions({
      wolfProposal: async () => 'p3',
      guardProtect: async () => null,
      witchDecision: async (_witchId, killTargetId) => {
        seen.push(killTargetId);
        return { kind: 'poison', targetId: 'p1' };
      },
      seerCheck: async () => 'p1',
    });

    const result = await runNight({ state, actions, random: noLottery });

    // 被刀的那一夜她还没用药，看得到刀口指向自己；不能自救是解药的规则，不是她看到的事实。
    expect(seen).toEqual(['p3']);
    expect(result.deaths).toEqual([
      { playerId: 'p3', cause: DEATH_CAUSES.NIGHT_KILL },
      { playerId: 'p1', cause: DEATH_CAUSES.WITCH_POISON },
    ]);
    // 死讯要等天亮公布才生效，夜里她仍然是活人。
    expect(playerOf(result.state, 'p3').isAlive).toBe(true);
  });

  it('狼队空刀，女巫看不到刀口，也就没得救', async () => {
    const state = board();
    const seen: (string | null)[] = [];
    const actions = stubActions({
      wolfProposal: async () => null,
      guardProtect: async () => null,
      witchDecision: async (_witchId, killTargetId) => {
        seen.push(killTargetId);
        return { kind: 'none' };
      },
      seerCheck: async () => 'p5',
    });

    const result = await runNight({ state, actions, random: noLottery });

    expect(seen).toEqual([null]);
    expect(result.deaths).toEqual([]);
    expect(playerOf(result.state, 'p3').hasAntidoteUsed).toBe(false);
  });

  it('解药已经用掉的女巫今夜看不到刀口', async () => {
    const state = patchPlayer(board(), 'p3', { hasAntidoteUsed: true });
    const seen: (string | null)[] = [];
    const actions = stubActions({
      wolfProposal: async () => 'p5',
      guardProtect: async () => null,
      witchDecision: async (_witchId, killTargetId) => {
        seen.push(killTargetId);
        return { kind: 'none' };
      },
      seerCheck: async () => 'p5',
    });

    const result = await runNight({ state, actions, random: noLottery });

    expect(seen).toEqual([null]);
    expect(playerOf(result.state, 'p3').hasAntidoteUsed).toBe(true);
  });

  it('守卫昨夜守过的人今夜不在候选里，今夜空守就把那次记录抹掉', async () => {
    const state = patchPlayer(board(), 'p2', { guardedOn: 'p5' });
    const offered: string[][] = [];
    const actions = stubActions({
      wolfProposal: async () => 'p6',
      guardProtect: async (_guardId, candidates) => {
        offered.push([...candidates]);
        return null;
      },
      witchDecision: async () => ({ kind: 'none' }),
      seerCheck: async () => 'p5',
    });

    const result = await runNight({ state, actions, random: noLottery });

    expect(offered).toEqual([['p1', 'p2', 'p3', 'p4', 'p6']]);
    expect(playerOf(result.state, 'p2').guardedOn).toBeNull();
    expect(result.deaths).toEqual([{ playerId: 'p6', cause: DEATH_CAUSES.NIGHT_KILL }]);
  });

  it('预言家查过的人不再出现在候选里，查验记进状态', async () => {
    const state = patchPlayer(board(), 'p4', { checkedIds: ['p5'] });
    const offered: string[][] = [];
    const actions = stubActions({
      wolfProposal: async () => 'p6',
      guardProtect: async () => null,
      witchDecision: async () => ({ kind: 'none' }),
      seerCheck: async (_seerId, candidates) => {
        offered.push([...candidates]);
        return 'p1';
      },
    });

    const result = await runNight({ state, actions, random: noLottery });

    expect(offered).toEqual([['p1', 'p2', 'p3', 'p6']]);
    expect(playerOf(result.state, 'p4').checkedIds).toEqual(['p5', 'p1']);
  });

  it('出局的神职不再睁眼，谁都不问他', async () => {
    let state = board();
    state = patchPlayer(state, 'p2', { isAlive: false });
    state = patchPlayer(state, 'p4', { isAlive: false });
    // 守卫与预言家都没有配置答案；真被问到就会抛错。
    const actions = stubActions({
      wolfProposal: async () => 'p5',
      witchDecision: async () => ({ kind: 'none' }),
    });

    const result = await runNight({ state, actions, random: noLottery });

    expect(result.check).toBeNull();
    expect(result.deaths).toEqual([{ playerId: 'p5', cause: DEATH_CAUSES.NIGHT_KILL }]);
  });

  it('局里没有神职时只走狼刀', async () => {
    const state = withRoles(makeState(4), { p1: ROLES.WEREWOLF });
    const actions = stubActions({ wolfProposal: async () => 'p3' });

    const result = await runNight({ state, actions, random: noLottery });

    expect(result.check).toBeNull();
    expect(result.deaths).toEqual([{ playerId: 'p3', cause: DEATH_CAUSES.NIGHT_KILL }]);
  });

  it('不修改传进来的状态', async () => {
    const state = board();
    const actions = stubActions({
      wolfProposal: async () => 'p5',
      guardProtect: async () => 'p6',
      witchDecision: async () => ({ kind: 'poison', targetId: 'p6' }),
      seerCheck: async () => 'p1',
    });

    const result = await runNight({ state, actions, random: noLottery });

    expect(playerOf(state, 'p2').guardedOn).toBeNull();
    expect(playerOf(state, 'p3').hasPoisonUsed).toBe(false);
    expect(playerOf(state, 'p4').checkedIds).toEqual([]);
    expect(playerOf(result.state, 'p2').guardedOn).toBe('p6');
    expect(playerOf(result.state, 'p4').checkedIds).toEqual(['p1']);
  });

  it('跨过一夜：守卫连着两夜守不住同一个人，哪怕那一夜平安', async () => {
    const offered: string[][] = [];
    const first = await runNight({
      state: board(),
      actions: stubActions({
        wolfProposal: async () => 'p6',
        guardProtect: async (_guardId, candidates) => {
          offered.push([...candidates]);
          return 'p6';
        },
        witchDecision: async () => ({ kind: 'none' }),
        seerCheck: async () => 'p1',
      }),
      random: noLottery,
    });

    // 守住了刀口，p6 天亮还活着——下一夜把他排掉只可能是因为状态位，不是因为他死了。
    expect(first.deaths).toEqual([]);
    const dawn = announceDay(first.state, first.deaths);
    expect(playerOf(dawn.state, 'p6').isAlive).toBe(true);

    const second = await runNight({
      state: dawn.state,
      actions: stubActions({
        wolfProposal: async () => 'p2',
        guardProtect: async (_guardId, candidates) => {
          offered.push([...candidates]);
          return null;
        },
        witchDecision: async () => ({ kind: 'none' }),
        seerCheck: async () => 'p5',
      }),
      random: noLottery,
    });

    expect(offered).toEqual([
      ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      ['p1', 'p2', 'p3', 'p4', 'p5'],
    ]);
    // 今夜空守，昨夜守过谁不再算数。
    expect(playerOf(second.state, 'p2').guardedOn).toBeNull();
  });

  it('跨过一夜：查过的人与死掉的人都不再是查验候选', async () => {
    const offered: string[][] = [];
    const first = await runNight({
      state: board(),
      actions: stubActions({
        wolfProposal: async () => 'p6',
        guardProtect: async () => null,
        witchDecision: async () => ({ kind: 'none' }),
        seerCheck: async (_seerId, candidates) => {
          offered.push([...candidates]);
          return 'p1';
        },
      }),
      random: noLottery,
    });
    expect(first.check).toEqual({ targetId: 'p1', result: SEER_CHECK_RESULTS.WEREWOLF });

    const dawn = announceDay(first.state, first.deaths);
    expect(playerOf(dawn.state, 'p6').isAlive).toBe(false);

    await runNight({
      state: dawn.state,
      actions: stubActions({
        wolfProposal: async () => 'p2',
        guardProtect: async () => null,
        witchDecision: async () => ({ kind: 'none' }),
        seerCheck: async (_seerId, candidates) => {
          offered.push([...candidates]);
          return 'p5';
        },
      }),
      random: noLottery,
    });

    expect(offered).toEqual([
      ['p1', 'p2', 'p3', 'p5', 'p6'],
      ['p2', 'p3', 'p5'],
    ]);
  });
});
