import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import { makeState, playerOf, stubActions, withRoles } from '../../testing/fixtures';
import { patchPlayer } from '../state';
import { decideWolfKingTake, wolfKingCanTake } from './wolf-king';

/** 六人局，p1 是狼王，已经出局。 */
function deadWolfKing() {
  return patchPlayer(withRoles(makeState(6), { p1: ROLES.WOLF_KING }), 'p1', { isAlive: false });
}

describe('狼王出局带人', () => {
  it('被狼刀、被放逐、被猎人打死、被白狼王带走、同守同救，都能带人', () => {
    expect(wolfKingCanTake(DEATH_CAUSES.NIGHT_KILL)).toBe(true);
    expect(wolfKingCanTake(DEATH_CAUSES.EXECUTION)).toBe(true);
    expect(wolfKingCanTake(DEATH_CAUSES.HUNTER_SHOT)).toBe(true);
    expect(wolfKingCanTake(DEATH_CAUSES.WHITE_WOLF_TAKE)).toBe(true);
    expect(wolfKingCanTake(DEATH_CAUSES.DOUBLE_SAVE)).toBe(true);
  });

  it('被毒、自爆，都带不了', () => {
    expect(wolfKingCanTake(DEATH_CAUSES.WITCH_POISON)).toBe(false);
    expect(wolfKingCanTake(DEATH_CAUSES.SELF_DESTRUCT)).toBe(false);
  });

  it('候选是其他存活玩家，已经出局的他自己不在里面', async () => {
    const state = deadWolfKing();
    let offered: readonly string[] = [];
    const actions = stubActions({
      wolfKingShot: async (_wolfKingId, candidates) => {
        offered = candidates;
        return 'p3';
      },
    });

    expect(await decideWolfKingTake(playerOf(state, 'p1'), state, actions)).toBe('p3');
    expect(offered).toEqual(['p2', 'p3', 'p4', 'p5', 'p6']);
  });

  it('他可以不带人', async () => {
    const state = deadWolfKing();

    expect(
      await decideWolfKingTake(
        playerOf(state, 'p1'),
        state,
        stubActions({ wolfKingShot: async () => null }),
      ),
    ).toBeNull();
  });

  it('场上没别人可带走就不问', async () => {
    const state = ['p2', 'p3', 'p4', 'p5', 'p6'].reduce(
      (next, playerId) => patchPlayer(next, playerId, { isAlive: false }),
      deadWolfKing(),
    );

    expect(await decideWolfKingTake(playerOf(state, 'p1'), state, stubActions())).toBeNull();
  });

  it('带到一个候选外的人身上就抛错', async () => {
    const state = deadWolfKing();
    const actions = stubActions({ wolfKingShot: async () => 'p1' });

    await expect(decideWolfKingTake(playerOf(state, 'p1'), state, actions)).rejects.toThrow(
      '狼王只能带走其他存活玩家：p1',
    );
  });
});
