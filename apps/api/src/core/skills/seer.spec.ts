import { FACTIONS, ROLES, SEER_CHECK_RESULTS } from '@werewolf/shared';
import { makeState, playerOf, stubActions, withRoles } from '../../testing/fixtures';
import { patchPlayer, type GameState } from '../state';
import { decideSeerCheck } from './seer';

/** 六人局，p1 是预言家，p4 是狼人；checkedIds 是他已经验过的人。 */
function seerBoard(checkedIds: string[] = []): GameState {
  return patchPlayer(withRoles(makeState(6), { p1: ROLES.SEER, p4: ROLES.WEREWOLF }), 'p1', {
    checkedIds,
  });
}

describe('预言家查验', () => {
  it('候选是没查过的其他存活玩家', async () => {
    const state = seerBoard();
    let offered: readonly string[] = [];
    const actions = stubActions({
      seerCheck: async (_seerId, candidates) => {
        offered = candidates;
        return 'p4';
      },
    });

    const check = await decideSeerCheck(playerOf(state, 'p1'), state, actions);

    expect(check).toEqual({ targetId: 'p4', result: SEER_CHECK_RESULTS.WEREWOLF });
    expect(offered).toEqual(['p2', 'p3', 'p4', 'p5', 'p6']);
  });

  it('查到好人阵营回 good', async () => {
    const state = seerBoard();

    const check = await decideSeerCheck(
      playerOf(state, 'p1'),
      state,
      stubActions({ seerCheck: async () => 'p2' }),
    );

    expect(check).toEqual({ targetId: 'p2', result: SEER_CHECK_RESULTS.GOOD });
  });

  it('狼王与白狼王和普通狼人同答 werewolf', async () => {
    const state = withRoles(seerBoard(), { p4: ROLES.WOLF_KING, p5: ROLES.WHITE_WOLF });
    const actions = stubActions({ seerCheck: async (_seerId, candidates) => candidates[2] });

    const check = await decideSeerCheck(playerOf(state, 'p1'), state, actions);

    expect(check?.targetId).toBe('p4');
    expect(check?.result).toBe(SEER_CHECK_RESULTS.WEREWOLF);
  });

  it('阵营被改过的人也按底牌回答，改的是此刻的阵营不是这张牌', async () => {
    const state = patchPlayer(seerBoard(), 'p2', { faction: FACTIONS.WEREWOLF });

    const check = await decideSeerCheck(
      playerOf(state, 'p1'),
      state,
      stubActions({ seerCheck: async () => 'p2' }),
    );

    expect(check).toEqual({ targetId: 'p2', result: SEER_CHECK_RESULTS.GOOD });
  });

  it('狼人被改成好人阵营，查验照样回 werewolf', async () => {
    const state = patchPlayer(seerBoard(), 'p4', { faction: FACTIONS.GOOD });

    const check = await decideSeerCheck(
      playerOf(state, 'p1'),
      state,
      stubActions({ seerCheck: async () => 'p4' }),
    );

    expect(check).toEqual({ targetId: 'p4', result: SEER_CHECK_RESULTS.WEREWOLF });
  });

  it('查过的人与出局的人都不再是候选', async () => {
    const state = patchPlayer(seerBoard(['p2', 'p3']), 'p5', { isAlive: false });
    let offered: readonly string[] = [];
    const actions = stubActions({
      seerCheck: async (_seerId, candidates) => {
        offered = candidates;
        return 'p4';
      },
    });

    await decideSeerCheck(playerOf(state, 'p1'), state, actions);

    expect(offered).toEqual(['p4', 'p6']);
  });

  it('没人可查时就不验，不问他', async () => {
    const state = seerBoard(['p2', 'p3', 'p4', 'p5', 'p6']);

    expect(await decideSeerCheck(playerOf(state, 'p1'), state, stubActions())).toBeNull();
  });

  it('局内没有预言家就不验', async () => {
    expect(await decideSeerCheck(null, makeState(6), stubActions())).toBeNull();
  });

  it('查一个候选外的人就抛错', async () => {
    const state = seerBoard(['p4']);
    const actions = stubActions({ seerCheck: async () => 'p4' });

    await expect(decideSeerCheck(playerOf(state, 'p1'), state, actions)).rejects.toThrow(
      '查验目标必须是没查过的其他存活玩家：p4',
    );
  });
});
