import { DEATH_CAUSES } from '@werewolf/shared';
import { makeState, stubActions } from '../../testing/fixtures';
import { announceDay } from './announce';
import { handOverBadge, settleBadgeAfterDeaths } from './badge';

describe('警徽处理', () => {
  it('移交给一名存活玩家', async () => {
    const state = { ...makeState(6), sheriffId: 'p1' };
    const actions = stubActions({ decideBadge: async () => ({ kind: 'transfer', toId: 'p4' }) });

    expect((await handOverBadge(state, actions, 'p1')).sheriffId).toBe('p4');
  });

  it('也可以撕掉', async () => {
    const state = { ...makeState(6), sheriffId: 'p1' };
    const actions = stubActions({ decideBadge: async () => ({ kind: 'tear' }) });

    expect((await handOverBadge(state, actions, 'p1')).sheriffId).toBeNull();
  });

  it('移交给已经出局的人会抛错', async () => {
    const state = announceDay({ ...makeState(6), sheriffId: 'p1' }, [
      { playerId: 'p2', cause: DEATH_CAUSES.NIGHT_KILL },
    ]).state;
    const actions = stubActions({ decideBadge: async () => ({ kind: 'transfer', toId: 'p2' }) });

    await expect(handOverBadge(state, actions, 'p1')).rejects.toThrow('警徽只能移交给存活玩家');
  });

  it('警长还活着时是空操作', async () => {
    // 没有配 decideBadge：空操作不该问任何人。这条让「多个入口重复调用」是安全的。
    const state = { ...makeState(6), sheriffId: 'p1' };

    expect(await settleBadgeAfterDeaths(state, stubActions())).toBe(state);
  });
});
