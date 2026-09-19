import { ROLES } from '@werewolf/shared';
import { makeState, playerOf, stubActions, withRoles } from '../../testing/fixtures';
import { patchPlayer, type GameState } from '../state';
import { decideGuard } from './guard';

/** 六人局，p1 是守卫；guardedOn 是他昨夜守过的人。 */
function guardBoard(guardedOn: string | null = null): GameState {
  return patchPlayer(withRoles(makeState(6), { p1: ROLES.GUARD }), 'p1', { guardedOn });
}

describe('守卫守护', () => {
  it('候选是全部存活玩家，含他自己', async () => {
    const state = guardBoard();
    let offered: readonly string[] = [];
    const actions = stubActions({
      guardProtect: async (_guardId, candidates) => {
        offered = candidates;
        return 'p2';
      },
    });

    expect(await decideGuard(playerOf(state, 'p1'), state, actions)).toBe('p2');
    expect(offered).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  });

  it('昨夜守过的人今夜不能守', async () => {
    const state = guardBoard('p4');
    let offered: readonly string[] = [];
    const actions = stubActions({
      guardProtect: async (_guardId, candidates) => {
        offered = candidates;
        return 'p5';
      },
    });

    expect(await decideGuard(playerOf(state, 'p1'), state, actions)).toBe('p5');
    expect(offered).not.toContain('p4');
  });

  it('昨夜守的人今夜出局了，他也不在候选里', async () => {
    const state = patchPlayer(guardBoard('p4'), 'p4', { isAlive: false });
    let offered: readonly string[] = [];
    const actions = stubActions({
      guardProtect: async (_guardId, candidates) => {
        offered = candidates;
        return 'p2';
      },
    });

    await decideGuard(playerOf(state, 'p1'), state, actions);

    expect(offered).toEqual(['p1', 'p2', 'p3', 'p5', 'p6']);
  });

  it('昨夜空守之后，今夜想守谁就守谁', async () => {
    const state = guardBoard(null);
    let offered: readonly string[] = [];
    const actions = stubActions({
      guardProtect: async (_guardId, candidates) => {
        offered = candidates;
        return 'p4';
      },
    });

    expect(await decideGuard(playerOf(state, 'p1'), state, actions)).toBe('p4');
    expect(offered).toContain('p4');
  });

  it('空守就是不守，返回 null', async () => {
    const state = guardBoard();

    expect(
      await decideGuard(
        playerOf(state, 'p1'),
        state,
        stubActions({ guardProtect: async () => null }),
      ),
    ).toBeNull();
  });

  it('局内没有守卫就不叫他', async () => {
    const state = makeState(6);

    expect(await decideGuard(null, state, stubActions())).toBeNull();
  });

  it('守一个候选外的人就抛错', async () => {
    const state = guardBoard('p4');
    const actions = stubActions({ guardProtect: async () => 'p4' });

    await expect(decideGuard(playerOf(state, 'p1'), state, actions)).rejects.toThrow(
      '守卫只能守护存活玩家，且不能连着两夜守同一个：p4',
    );
  });

  it('守出局的人就抛错', async () => {
    const state = patchPlayer(guardBoard(), 'p4', { isAlive: false });
    const actions = stubActions({ guardProtect: async () => 'p4' });

    await expect(decideGuard(playerOf(state, 'p1'), state, actions)).rejects.toThrow(
      '守卫只能守护存活玩家',
    );
  });
});
