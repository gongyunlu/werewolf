import { ACTION_TYPES } from '@werewolf/shared';
import { actionKey, phaseInstanceId, type ActionScope } from '../core/identity';
import { actionOrdinals } from './request';

const dayNode: ActionScope = { gameId: 'g1', phaseInstanceId: phaseInstanceId(3, 'day') };

describe('行动序号', () => {
  it('同一格里连问多次，序号依次往下走', () => {
    const next = actionOrdinals();

    expect([
      next(dayNode, ACTION_TYPES.WOLF_EXPLODE, 'p1'),
      next(dayNode, ACTION_TYPES.WOLF_EXPLODE, 'p1'),
      next(dayNode, ACTION_TYPES.WOLF_EXPLODE, 'p1'),
    ]).toEqual([0, 1, 2]);
  });

  it('换个人、换个事件类型、换个节点实例，各自从 0 起', () => {
    const next = actionOrdinals();
    next(dayNode, ACTION_TYPES.WOLF_EXPLODE, 'p1');

    expect(next(dayNode, ACTION_TYPES.WOLF_EXPLODE, 'p2')).toBe(0);
    expect(next(dayNode, ACTION_TYPES.SPEECH, 'p1')).toBe(0);

    const voteNode: ActionScope = { gameId: 'g1', phaseInstanceId: phaseInstanceId(4, 'day') };
    expect(next(voteNode, ACTION_TYPES.WOLF_EXPLODE, 'p1')).toBe(0);
  });

  it('编号拼进行动键，逐段发言的窗口才认得出谁是谁', () => {
    const next = actionOrdinals();
    const keyOf = () =>
      actionKey(dayNode, ACTION_TYPES.SPEECH, 'p1', next(dayNode, ACTION_TYPES.SPEECH, 'p1'));

    expect(keyOf()).not.toBe(keyOf());
  });
});
