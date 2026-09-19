import { ROLES } from '@werewolf/shared';
import { makeState, stubActions, withRoles } from '../../testing/fixtures';
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

/** 一抽签就炸的随机源，这个用例不该走到并列。 */
function noLottery(): never {
  throw new Error('没有人并列时不该抽签');
}

describe('狼队提刀', () => {
  it('取提得最多的那个', async () => {
    const actions = stubActions({
      wolfProposal: async (wolfId) => (wolfId === 'p1' ? 'p4' : 'p5'),
    });

    expect(await decideWolfKill(wolfBoard(), actions, noLottery)).toBe('p5');
  });

  it('每只活狼提一次，候选是全部存活玩家，狼队友与自己都在里面', async () => {
    const seen: string[][] = [];
    const actions = stubActions({
      wolfProposal: async (wolfId, candidates) => {
        seen.push([wolfId, ...candidates]);
        return 'p4';
      },
    });

    await decideWolfKill(wolfBoard(), actions, noLottery);

    expect(seen).toEqual([
      ['p1', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      ['p2', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      ['p3', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
    ]);
  });

  it('出局的狼不再提刀，也不再是谁的刀口', async () => {
    const asked: string[] = [];
    const offered: string[] = [];
    const actions = stubActions({
      wolfProposal: async (wolfId, candidates) => {
        asked.push(wolfId);
        offered.push(...candidates);
        return 'p4';
      },
    });

    const state = patchPlayer(wolfBoard(), 'p3', { isAlive: false });

    expect(await decideWolfKill(state, actions, noLottery)).toBe('p4');
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
    const actions = stubActions({
      wolfProposal: async (wolfId) => {
        asked.push(wolfId);
        return null;
      },
    });

    await decideWolfKill(state, actions, noLottery);

    expect(asked).toEqual(['p1', 'p2', 'p3']);
  });

  it('并列最高时随机挑一个', async () => {
    const actions = stubActions({
      wolfProposal: async (wolfId) => (wolfId === 'p1' ? 'p4' : wolfId === 'p2' ? 'p5' : 'p6'),
    });

    expect(await decideWolfKill(wolfBoard(), actions, () => 0)).toBe('p4');
    expect(await decideWolfKill(wolfBoard(), actions, () => 0.99)).toBe('p6');
  });

  it('三狼一致空刀就是空刀，不抽签', async () => {
    const actions = stubActions({ wolfProposal: async () => null });

    expect(await decideWolfKill(wolfBoard(), actions, noLottery)).toBeNull();
  });

  it('空刀与刀口并列时一起抽签', async () => {
    const actions = stubActions({
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

    expect(await decideWolfKill(state, stubActions(), noLottery)).toBeNull();
  });

  it('提出局外的人就抛错', async () => {
    const actions = stubActions({ wolfProposal: async () => 'p9' });

    await expect(decideWolfKill(wolfBoard(), actions, noLottery)).rejects.toThrow(
      '狼刀只能落在存活玩家身上',
    );
  });
});
