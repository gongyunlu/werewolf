import { ROLES } from '@werewolf/shared';
import { makeState, stubActions, withRoles } from '../../testing/fixtures';
import type { ActionProvider } from '../actions';
import { patchPlayer } from '../state';
import { decideWolfKill } from './werewolf';

/** 三狼局：p1、p2、p3 是狼人，其余平民。 */
function wolfBoard() {
  return withRoles(makeState(6), {
    p1: ROLES.WEREWOLF,
    p2: ROLES.WEREWOLF,
    p3: ROLES.WEREWOLF,
  });
}

/**
 * 三狼局一开场要先抽两次定发言顺序，那两下照给；再抽就是提刀并列了。
 * 这些用例都不该走到并列，抽第三下就炸。
 */
function noLottery(): () => number {
  let drawn = 0;
  return () => {
    drawn += 1;
    if (drawn > 2) throw new Error('没有人并列时不该抽签');
    return 0;
  };
}

/** 每抽一次就往下走的随机源：两轮各自重抽一遍的话，第二轮的顺序就跟第一轮对不上。 */
function varyingLottery(): () => number {
  let nth = 0;
  return () => {
    nth += 1;
    return (nth % 7) / 7;
  };
}

/**
 * 提刀用例的行动提供者：商议发言统一给一句。
 * 这几条看的是提完刀怎么定，商议说了什么与刀口无关；要看商议本身的用例覆盖 wolfSpeech。
 */
function killActions(overrides: Partial<ActionProvider>): ActionProvider {
  return stubActions({ wolfSpeech: async () => '今晚听你们的。', ...overrides });
}

/** 记下每一次商议发言：第几轮、谁说、当时发到手的那份顺序。 */
function talkingPack(proposals: Partial<ActionProvider>) {
  const spoken: { round: number; wolfId: string; order: readonly string[] }[] = [];
  const actions = killActions({
    wolfSpeech: async (wolfId, round, order) => {
      spoken.push({ round, wolfId, order: [...order] });
      return `${wolfId} 的第 ${round} 轮`;
    },
    ...proposals,
  });

  return { spoken, actions };
}

describe('狼队提刀', () => {
  it('一只狼失败后等待其他提案收尾再返回失败', async () => {
    let release!: (value: string) => void;
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });
    const failed = jest.fn();
    const result = decideWolfKill(
      wolfBoard(),
      killActions({
        wolfProposal: async (id) => {
          if (id === 'p1') throw new Error('提刀失败');
          return id === 'p2' ? slow : 'p4';
        },
      }),
      () => 0,
    ).catch(failed);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(failed).not.toHaveBeenCalled();
    release('p4');
    await result;
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: '提刀失败' }));
  });

  it('取提得最多的那个', async () => {
    const actions = killActions({
      wolfProposal: async (wolfId) => (wolfId === 'p1' ? 'p4' : 'p5'),
    });

    expect(await decideWolfKill(wolfBoard(), actions, noLottery())).toBe('p5');
  });

  it('每只活狼提一次，候选是全部存活玩家，狼队友与自己都在里面', async () => {
    const seen: string[][] = [];
    const actions = killActions({
      wolfProposal: async (wolfId, candidates) => {
        seen.push([wolfId, ...candidates]);
        return 'p4';
      },
    });

    await decideWolfKill(wolfBoard(), actions, noLottery());

    expect(seen).toEqual([
      ['p1', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      ['p2', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      ['p3', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
    ]);
  });

  it('出局的狼不再提刀，也不再是谁的刀口', async () => {
    const asked: string[] = [];
    const offered: string[] = [];
    const actions = killActions({
      wolfProposal: async (wolfId, candidates) => {
        asked.push(wolfId);
        offered.push(...candidates);
        return 'p4';
      },
    });

    const state = patchPlayer(wolfBoard(), 'p3', { isAlive: false });

    expect(await decideWolfKill(state, actions, noLottery())).toBe('p4');
    expect(asked).toEqual(['p1', 'p2']);
    expect(offered).not.toContain('p3');
  });

  it('狼王与白狼王和普通狼人一样有份提刀', async () => {
    const asked: string[] = [];
    const state = withRoles(makeState(6), {
      p1: ROLES.WEREWOLF,
      p2: ROLES.WOLF_KING,
      p3: ROLES.WHITE_WOLF,
    });
    const actions = killActions({
      wolfProposal: async (wolfId) => {
        asked.push(wolfId);
        return null;
      },
    });

    await decideWolfKill(state, actions, noLottery());

    expect(asked).toEqual(['p1', 'p2', 'p3']);
  });

  it('并列最高时随机挑一个', async () => {
    const actions = killActions({
      wolfProposal: async (wolfId) => (wolfId === 'p1' ? 'p4' : wolfId === 'p2' ? 'p5' : 'p6'),
    });

    expect(await decideWolfKill(wolfBoard(), actions, () => 0)).toBe('p4');
    expect(await decideWolfKill(wolfBoard(), actions, () => 0.99)).toBe('p6');
  });

  it('三狼一致空刀就是空刀，不抽签', async () => {
    const actions = killActions({ wolfProposal: async () => null });

    expect(await decideWolfKill(wolfBoard(), actions, noLottery())).toBeNull();
  });

  it('空刀与刀口并列时一起抽签', async () => {
    const actions = killActions({
      wolfProposal: async (wolfId) => (wolfId === 'p1' ? null : wolfId === 'p2' ? 'p4' : 'p5'),
    });

    expect(await decideWolfKill(wolfBoard(), actions, () => 0)).toBeNull();
    expect(await decideWolfKill(wolfBoard(), actions, () => 0.99)).toBe('p5');
  });

  it('狼全出局时空刀，谁都不问', async () => {
    let state = wolfBoard();
    for (const id of ['p1', 'p2', 'p3']) {
      state = patchPlayer(state, id, { isAlive: false });
    }

    expect(await decideWolfKill(state, stubActions(), noLottery())).toBeNull();
  });

  it('提出局外的人就抛错', async () => {
    const actions = killActions({ wolfProposal: async () => 'p9' });

    await expect(decideWolfKill(wolfBoard(), actions, noLottery())).rejects.toThrow(
      '狼刀只能落在存活玩家身上',
    );
  });
});

describe('狼队商议', () => {
  it('三狼局走满两轮，每狼每轮恰说一次', async () => {
    const { spoken, actions } = talkingPack({ wolfProposal: async () => 'p4' });

    expect(await decideWolfKill(wolfBoard(), actions, noLottery())).toBe('p4');

    const first = spoken.slice(0, 3).map((item) => item.wolfId);
    expect(spoken.map((item) => item.round)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(spoken.slice(3).map((item) => item.wolfId)).toEqual(first);
    expect(first.toSorted()).toEqual(['p1', 'p2', 'p3']);
  });

  it('发言顺序整夜只抽一次，两轮用的是同一份', async () => {
    const { spoken, actions } = talkingPack({ wolfProposal: async () => 'p4' });

    await decideWolfKill(wolfBoard(), actions, varyingLottery());

    // 抽出来是哪一份由随机源定，用例认的是整夜只有一份：两轮各自重抽就该对不上。
    const [order] = spoken;
    expect(order.order.toSorted()).toEqual(['p1', 'p2', 'p3']);
    expect(spoken.every((item) => item.order.join('、') === order.order.join('、'))).toBe(true);
    // 每一轮都是照着这份顺序挨个叫的。
    expect(spoken.slice(0, 3).map((item) => item.wolfId)).toEqual([...order.order]);
  });

  it('只剩一只狼时没人可商量，一次都不问', async () => {
    let state = wolfBoard();
    state = patchPlayer(state, 'p2', { isAlive: false });
    state = patchPlayer(state, 'p3', { isAlive: false });

    // 没配 wolfSpeech：真被问到就会抛错。
    const actions = stubActions({ wolfProposal: async () => 'p4' });

    expect(await decideWolfKill(state, actions, noLottery())).toBe('p4');
  });
});
