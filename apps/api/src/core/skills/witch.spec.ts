import { ROLES } from '@werewolf/shared';
import { makeState, playerOf, stubActions, withRoles } from '../../testing/fixtures';
import { patchPlayer, type GameState } from '../state';
import { decideWitch } from './witch';

/** 六人局，p1 是女巫；用药状态位按用例给。 */
function witchBoard(patch: { hasAntidoteUsed?: boolean; hasPoisonUsed?: boolean } = {}): GameState {
  return patchPlayer(withRoles(makeState(6), { p1: ROLES.WITCH }), 'p1', patch);
}

describe('女巫用药', () => {
  it('解药唯一能落的地方就是今晚的刀口', async () => {
    const state = witchBoard();
    const seen: (string | null)[] = [];
    const actions = stubActions({
      witchDecision: async (_witchId, killTargetId) => {
        seen.push(killTargetId);
        return { kind: 'antidote' };
      },
    });

    const action = await decideWitch(playerOf(state, 'p1'), state, 'p4', actions);

    expect(seen).toEqual(['p4']);
    expect(action).toEqual({ antidoteTargetId: 'p4', poisonTargetId: null });
  });

  it('刀口是她自己时照原样给她：看得到刀口与能不能自救是两回事', async () => {
    const state = witchBoard();
    const seen: (string | null)[] = [];
    const actions = stubActions({
      witchDecision: async (_witchId, killTargetId) => {
        seen.push(killTargetId);
        return { kind: 'none' };
      },
    });

    const action = await decideWitch(playerOf(state, 'p1'), state, 'p1', actions);

    expect(seen).toEqual(['p1']);
    expect(action).toEqual({ antidoteTargetId: null, poisonTargetId: null });
  });

  it('刀口是她自己时选了救就抛错', async () => {
    const state = witchBoard();
    const actions = stubActions({ witchDecision: async () => ({ kind: 'antidote' }) });

    await expect(decideWitch(playerOf(state, 'p1'), state, 'p1', actions)).rejects.toThrow(
      'p1 今夜不能自救，或解药没有可救的目标',
    );
  });

  it('解药已经用掉就不再看到刀口', async () => {
    const state = witchBoard({ hasAntidoteUsed: true });
    const seen: (string | null)[] = [];
    const actions = stubActions({
      witchDecision: async (_witchId, killTargetId) => {
        seen.push(killTargetId);
        return { kind: 'none' };
      },
    });

    await decideWitch(playerOf(state, 'p1'), state, 'p4', actions);

    expect(seen).toEqual([null]);
  });

  it('狼队空刀时看不到刀口', async () => {
    const state = witchBoard();
    const seen: (string | null)[] = [];
    const actions = stubActions({
      witchDecision: async (_witchId, killTargetId) => {
        seen.push(killTargetId);
        return { kind: 'none' };
      },
    });

    await decideWitch(playerOf(state, 'p1'), state, null, actions);

    expect(seen).toEqual([null]);
  });

  it('毒药候选是其他存活玩家，不含她自己', async () => {
    const state = patchPlayer(witchBoard(), 'p5', { isAlive: false });
    let offered: readonly string[] = [];
    const actions = stubActions({
      witchDecision: async (_witchId, _killTargetId, poisonCandidates) => {
        offered = poisonCandidates;
        return { kind: 'none' };
      },
    });

    await decideWitch(playerOf(state, 'p1'), state, 'p4', actions);

    expect(offered).toEqual(['p2', 'p3', 'p4', 'p6']);
  });

  it('毒药已经用掉就没有毒药候选', async () => {
    const state = witchBoard({ hasPoisonUsed: true });
    let offered: readonly string[] = [];
    const actions = stubActions({
      witchDecision: async (_witchId, _killTargetId, poisonCandidates) => {
        offered = poisonCandidates;
        return { kind: 'none' };
      },
    });

    await decideWitch(playerOf(state, 'p1'), state, 'p4', actions);

    expect(offered).toEqual([]);
  });

  it('她要毒谁就是谁，这一夜就不动解药', async () => {
    const state = witchBoard();
    const actions = stubActions({
      witchDecision: async () => ({ kind: 'poison', targetId: 'p5' }),
    });

    expect(await decideWitch(playerOf(state, 'p1'), state, 'p4', actions)).toEqual({
      antidoteTargetId: null,
      poisonTargetId: 'p5',
    });
  });

  it('解药救过人之后，毒药照样能用', async () => {
    const state = witchBoard({ hasAntidoteUsed: true });
    const actions = stubActions({
      witchDecision: async () => ({ kind: 'poison', targetId: 'p5' }),
    });

    expect(await decideWitch(playerOf(state, 'p1'), state, 'p4', actions)).toEqual({
      antidoteTargetId: null,
      poisonTargetId: 'p5',
    });
  });

  it('两种药都用不上就不叫醒她', async () => {
    const state = witchBoard({ hasAntidoteUsed: true, hasPoisonUsed: true });

    expect(await decideWitch(playerOf(state, 'p1'), state, 'p4', stubActions())).toEqual({
      antidoteTargetId: null,
      poisonTargetId: null,
    });
  });

  it('局内没有女巫就没有用药这回事', async () => {
    const state = makeState(6);

    expect(await decideWitch(null, state, 'p4', stubActions())).toEqual({
      antidoteTargetId: null,
      poisonTargetId: null,
    });
  });

  it('毒药落在一个候选外的人身上就抛错', async () => {
    const state = witchBoard();
    const actions = stubActions({
      witchDecision: async () => ({ kind: 'poison', targetId: 'p1' }),
    });

    await expect(decideWitch(playerOf(state, 'p1'), state, 'p4', actions)).rejects.toThrow(
      '毒药只能落在其他存活玩家身上：p1',
    );
  });

  it('解药已经用掉还选救就抛错', async () => {
    const state = witchBoard({ hasAntidoteUsed: true });
    const actions = stubActions({ witchDecision: async () => ({ kind: 'antidote' }) });

    await expect(decideWitch(playerOf(state, 'p1'), state, 'p4', actions)).rejects.toThrow(
      'p1 今夜不能自救，或解药没有可救的目标',
    );
  });
});
