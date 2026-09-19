import { DEATH_CAUSES } from '@werewolf/shared';
import { resolveNight, type NightActions } from './resolve';

/** 只写有落点的那几步，其余默认没有。 */
function night(patch: Partial<NightActions> = {}) {
  return resolveNight({
    wolfTargetId: null,
    guardTargetId: null,
    antidoteTargetId: null,
    poisonTargetId: null,
    ...patch,
  });
}

describe('夜间结算', () => {
  it('什么都没有就是平安夜', () => {
    expect(night()).toEqual([]);
  });

  it('刀口没人护没人救就被刀死', () => {
    expect(night({ wolfTargetId: 'p4' })).toEqual([
      { playerId: 'p4', cause: DEATH_CAUSES.NIGHT_KILL },
    ]);
  });

  it('守卫守中刀口，人就活下来', () => {
    expect(night({ wolfTargetId: 'p4', guardTargetId: 'p4' })).toEqual([]);
  });

  it('女巫救中刀口，人就活下来', () => {
    expect(night({ wolfTargetId: 'p4', antidoteTargetId: 'p4' })).toEqual([]);
  });

  it('守别人不顶用，刀口照死', () => {
    expect(night({ wolfTargetId: 'p4', guardTargetId: 'p5' })).toEqual([
      { playerId: 'p4', cause: DEATH_CAUSES.NIGHT_KILL },
    ]);
  });

  it('同守同救：两重保护扣在一起，人被刀死', () => {
    expect(night({ wolfTargetId: 'p4', guardTargetId: 'p4', antidoteTargetId: 'p4' })).toEqual([
      { playerId: 'p4', cause: DEATH_CAUSES.DOUBLE_SAVE },
    ]);
  });

  it('毒药单独就能毒死人', () => {
    expect(night({ poisonTargetId: 'p5' })).toEqual([
      { playerId: 'p5', cause: DEATH_CAUSES.WITCH_POISON },
    ]);
  });

  it('盾挡的是狼刀，不是毒：被守护的人照样被毒死', () => {
    expect(night({ wolfTargetId: 'p4', guardTargetId: 'p4', poisonTargetId: 'p4' })).toEqual([
      { playerId: 'p4', cause: DEATH_CAUSES.WITCH_POISON },
    ]);
  });

  it('刀口被救活，被毒的是另一个人，死的是被毒的', () => {
    expect(night({ wolfTargetId: 'p4', antidoteTargetId: 'p4', poisonTargetId: 'p6' })).toEqual([
      { playerId: 'p6', cause: DEATH_CAUSES.WITCH_POISON },
    ]);
  });

  it('一个人既被刀又被毒，只公布一条死讯，死因取毒', () => {
    expect(night({ wolfTargetId: 'p4', poisonTargetId: 'p4' })).toEqual([
      { playerId: 'p4', cause: DEATH_CAUSES.WITCH_POISON },
    ]);
  });

  it('同守同救再被毒，死因同样取毒', () => {
    expect(
      night({
        wolfTargetId: 'p4',
        guardTargetId: 'p4',
        antidoteTargetId: 'p4',
        poisonTargetId: 'p4',
      }),
    ).toEqual([{ playerId: 'p4', cause: DEATH_CAUSES.WITCH_POISON }]);
  });

  it('一夜死两个人时，刀口排在毒药之前', () => {
    expect(night({ wolfTargetId: 'p2', poisonTargetId: 'p5' })).toEqual([
      { playerId: 'p2', cause: DEATH_CAUSES.NIGHT_KILL },
      { playerId: 'p5', cause: DEATH_CAUSES.WITCH_POISON },
    ]);
  });

  it('结算不动状态，也不改传进来的落点', () => {
    const actions: NightActions = {
      wolfTargetId: 'p4',
      guardTargetId: 'p4',
      antidoteTargetId: 'p4',
      poisonTargetId: null,
    };

    expect(resolveNight(actions)).toEqual([{ playerId: 'p4', cause: DEATH_CAUSES.DOUBLE_SAVE }]);
    expect(actions).toEqual({
      wolfTargetId: 'p4',
      guardTargetId: 'p4',
      antidoteTargetId: 'p4',
      poisonTargetId: null,
    });
  });
});
