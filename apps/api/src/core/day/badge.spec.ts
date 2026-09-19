import { makeState, stubActions } from '../../testing/fixtures';
import { settleBadgeAfterDeaths } from './badge';

describe('死讯落下后的警徽', () => {
  it('警长还活着就不动警徽', async () => {
    // 没配 decideBadge，一旦问到就会失败。
    const state = { ...makeState(6), sheriffId: 'p1' };
    const result = await settleBadgeAfterDeaths(state, stubActions());

    expect(result).toBe(state);
  });

  it('没有警长时不提问', async () => {
    const state = makeState(6);
    const result = await settleBadgeAfterDeaths(state, stubActions());

    expect(result).toBe(state);
  });

  it('警长不在局内就抛错', async () => {
    const state = { ...makeState(6), sheriffId: 'p9' };

    await expect(settleBadgeAfterDeaths(state, stubActions())).rejects.toThrow('警长不在局内');
  });
});
