import { ballotOf, stubActions, makeState } from '../../testing/fixtures';
import { runSheriffElection } from './election';

/** 22 分的个位是 2（双数），警上发言从 2 号位起逆时针。 */
const MINUTE = 22;

/** 上警名单，其余人都是警下。 */
function campaignOf(campaigners: readonly string[], withdrawers: readonly string[] = []) {
  return {
    runForSheriff: async (playerId: string) => campaigners.includes(playerId),
    withdraw: async (playerId: string) => withdrawers.includes(playerId),
  };
}

describe('警长竞选', () => {
  it('本局没有警长环节时不提问', async () => {
    const result = await runSheriffElection(makeState(6, false), stubActions(), MINUTE);

    expect(result.state.sheriffId).toBeNull();
    expect(result.speeches).toEqual([]);
  });

  it('第二天不再重选警长', async () => {
    // 没配 runForSheriff，一旦问到就会失败。
    const actions = stubActions();
    const state = { ...makeState(6), day: 2, sheriffId: 'p1' };
    const result = await runSheriffElection(state, actions, MINUTE);

    expect(result.state.sheriffId).toBe('p1');
    expect(result.speeches).toEqual([]);
  });

  it('首日没选出警长，第二天也不补选', async () => {
    // 判据是天数而不是 sheriffId 是否为空：警徽流失和还没选过都是 null，都不重选。
    const actions = stubActions();
    const state = { ...makeState(6), day: 2, sheriffId: null };
    const result = await runSheriffElection(state, actions, MINUTE);

    expect(result.state.sheriffId).toBeNull();
    expect(result.speeches).toEqual([]);
  });

  it('没人上警就没有警长', async () => {
    const actions = stubActions({ runForSheriff: async () => false });
    const result = await runSheriffElection(makeState(6), actions, MINUTE);

    expect(result.state.sheriffId).toBeNull();
    expect(result.speeches).toEqual([]);
  });

  it('只有一人上警时直接当选，不走投票', async () => {
    const actions = stubActions({
      ...campaignOf(['p1']),
      speak: async () => '我上警',
    });
    const result = await runSheriffElection(makeState(6), actions, MINUTE);

    expect(result.state.sheriffId).toBe('p1');
    expect(result.speeches.map((speech) => speech.playerId)).toEqual(['p1']);
  });

  it('警上全部退水就没有警长', async () => {
    const actions = stubActions({
      ...campaignOf(['p1', 'p2'], ['p1', 'p2']),
      speak: async () => '上警发言',
    });
    const result = await runSheriffElection(makeState(6), actions, MINUTE);

    expect(result.state.sheriffId).toBeNull();
  });

  it('全员上警时没人有投票权，警徽流失', async () => {
    const actions = stubActions({
      ...campaignOf(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']),
      speak: async () => '上警',
    });
    const result = await runSheriffElection(makeState(6), actions, MINUTE);

    expect(result.state.sheriffId).toBeNull();
  });

  it('警上发言按单顺双逆排序', async () => {
    const actions = stubActions({
      ...campaignOf(['p1', 'p2', 'p3'], ['p3']),
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      vote: ballotOf({ p4: 'p1', p5: 'p1', p6: 'p2' }),
    });
    const result = await runSheriffElection(makeState(6), actions, MINUTE);

    expect(result.speeches.map((speech) => speech.seatNo)).toEqual([2, 1, 3]);
  });

  it('警下投票选出得票最多的人', async () => {
    const actions = stubActions({
      ...campaignOf(['p1', 'p2', 'p3'], ['p3']),
      speak: async () => '上警发言',
      vote: ballotOf({ p4: 'p1', p5: 'p1', p6: 'p2' }),
    });
    const result = await runSheriffElection(makeState(6), actions, MINUTE);

    // p3 退水后候选只剩 p1、p2，投票的是警下的 p4、p5、p6。
    expect(result.state.sheriffId).toBe('p1');
  });

  it('退水的人既不能被选，也不能投票', async () => {
    const actions = stubActions({
      ...campaignOf(['p1', 'p2', 'p3'], ['p3']),
      speak: async () => '上警发言',
      // 答案表里没有 p3，问到他就会失败。
      vote: ballotOf({ p4: 'p2', p5: 'p2', p6: 'p2' }),
    });
    const result = await runSheriffElection(makeState(6), actions, MINUTE);

    expect(result.state.sheriffId).toBe('p2');
  });

  it('警下全员弃票则警徽流失', async () => {
    const actions = stubActions({
      ...campaignOf(['p1', 'p2']),
      speak: async () => '上警发言',
      vote: async () => null,
    });
    const result = await runSheriffElection(makeState(6), actions, MINUTE);

    expect(result.state.sheriffId).toBeNull();
  });

  it('竞选 PK 全员弃票也是警徽流失', async () => {
    const actions = stubActions({
      ...campaignOf(['p1', 'p2', 'p3']),
      speak: async () => '发言',
      vote: async (turn, playerId) =>
        (turn === 'campaign'
          ? ballotOf({ p4: 'p1', p5: 'p2', p6: 'p3' })
          : ballotOf({ p4: null, p5: null, p6: null }))(turn, playerId),
    });
    const result = await runSheriffElection(makeState(6), actions, MINUTE);

    expect(result.state.sheriffId).toBeNull();
  });

  it('平票时平票者按相反顺序再发言一轮，再投一次', async () => {
    // 首轮三人各得一票，PK 轮改投 p3。
    const actions = stubActions({
      ...campaignOf(['p1', 'p2', 'p3']),
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      vote: async (turn, playerId) =>
        (turn === 'campaign'
          ? ballotOf({ p4: 'p1', p5: 'p2', p6: 'p3' })
          : ballotOf({ p4: 'p3', p5: 'p3', p6: 'p1' }))(turn, playerId),
    });

    const result = await runSheriffElection(makeState(6), actions, MINUTE);

    expect(result.state.sheriffId).toBe('p3');
    // 首轮警上顺序是 2、1、3，PK 轮倒过来就是 3、1、2。
    expect(result.speeches.map((speech) => [speech.turn, speech.seatNo])).toEqual([
      ['campaign', 2],
      ['campaign', 1],
      ['campaign', 3],
      ['campaign_pk', 3],
      ['campaign_pk', 1],
      ['campaign_pk', 2],
    ]);
  });

  it('PK 再平票则警徽流失', async () => {
    const actions = stubActions({
      ...campaignOf(['p1', 'p2', 'p3']),
      speak: async () => '发言',
      vote: ballotOf({ p4: 'p1', p5: 'p2', p6: 'p3' }),
    });

    const result = await runSheriffElection(makeState(6), actions, MINUTE);

    expect(result.state.sheriffId).toBeNull();
  });
});
