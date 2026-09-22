import { makeState, stubActions } from '../../testing/fixtures';
import { speakInOrder } from './speech';

describe('依次发言', () => {
  it('按给定顺序请人发言，产出就是实际顺序', async () => {
    const actions = stubActions({ speak: async (turn, playerId) => `${turn}:${playerId}` });
    const speeches = await speakInOrder('day', [3, 1, 4], makeState(4).players, actions);

    expect(speeches).toEqual([
      { turn: 'day', playerId: 'p3', seatNo: 3, content: 'day:p3' },
      { turn: 'day', playerId: 'p1', seatNo: 1, content: 'day:p1' },
      { turn: 'day', playerId: 'p4', seatNo: 4, content: 'day:p4' },
    ]);
  });

  it('每个人拿到的都是这一轮完整的顺序，后面还有谁也在里面', async () => {
    const seen: Record<string, readonly string[]> = {};
    const actions = stubActions({
      speak: async (turn, playerId, order) => {
        seen[playerId] = order;
        return '';
      },
    });

    await speakInOrder('campaign', [3, 1], makeState(4).players, actions);

    // 不是「轮到谁就只给他排到谁」：还没说的那几个人他得知道是谁。
    expect(seen).toEqual({ p3: ['p3', 'p1'], p1: ['p3', 'p1'] });
  });

  it('上一个人说完才轮到下一个', async () => {
    const log: string[] = [];
    const actions = stubActions({
      speak: async (turn, playerId) => {
        log.push(`开始 ${playerId}`);
        await new Promise((resolve) => setImmediate(resolve));
        log.push(`说完 ${playerId}`);
        return '';
      },
    });

    await speakInOrder('day', [1, 2], makeState(2).players, actions);

    expect(log).toEqual(['开始 p1', '说完 p1', '开始 p2', '说完 p2']);
  });

  it('顺序里的座位号不在局内就抛错', async () => {
    const actions = stubActions({ speak: async () => '' });

    await expect(speakInOrder('day', [9], makeState(4).players, actions)).rejects.toThrow(
      '发言顺序里的座位号不在局内',
    );
  });

  it('没轮到的座位号不会被问到', async () => {
    const actions = stubActions({ speak: async (turn, playerId) => `${turn}:${playerId}` });
    const speeches = await speakInOrder('campaign_pk', [2], makeState(4).players, actions);

    expect(speeches).toEqual([
      { turn: 'campaign_pk', playerId: 'p2', seatNo: 2, content: 'campaign_pk:p2' },
    ]);
  });

  it('空顺序就是没人发言', async () => {
    // 没有配 speak，一旦问到就会失败。
    const speeches = await speakInOrder('day', [], makeState(4).players, stubActions());

    expect(speeches).toEqual([]);
  });
});
