import { ROLES } from '@werewolf/shared';
import { ballotOf, stubActions, makeState, withRoles } from '../../testing/fixtures';
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
    // 竞选到此为止，落定之后不再有警长。
    expect(result.state.sheriffElectionSettled).toBe(true);
  });
});

/** 挂起中的竞选：第一天已经爆过一次，上警的是 p1、p2。 */
function resumedState() {
  return {
    ...withRoles(makeState(6), { p4: ROLES.WEREWOLF }),
    day: 2,
    sheriffElectionSuspended: ['p1', 'p2'],
  };
}

describe('警长竞选 · 被狼人自爆打断', () => {
  it('首轮被打断：上警名单挂起，警徽先留着', async () => {
    const state = withRoles(makeState(6), { p3: ROLES.WEREWOLF });
    const resumingFlags: boolean[] = [];
    const actions = stubActions({
      ...campaignOf(['p1', 'p2']),
      wolfBlast: async (wolfId, resuming) => {
        resumingFlags.push(resuming);
        return wolfId === 'p3';
      },
    });

    const result = await runSheriffElection(state, actions, MINUTE);

    expect(resumingFlags).toEqual([false]);
    expect(result.aborted).toBe(true);
    expect(result.state.sheriffId).toBeNull();
    expect(result.state.sheriffElectionSuspended).toEqual(['p1', 'p2']);
    // 挂起待续，还不算落定。
    expect(result.state.sheriffElectionSettled).toBe(false);
    // 爆在警上发言之前，这一天就到这儿了。
    expect(result.speeches).toEqual([]);
  });

  it('续轮跳过报名与警上发言，直接进退水表态', async () => {
    // 没配 runForSheriff 与 speak：续轮不该问到它们。
    const actions = stubActions({
      withdraw: async () => false,
      wolfBlast: async () => false,
      vote: ballotOf({ p3: 'p1', p4: 'p1', p5: 'p2', p6: 'p1' }),
    });

    const result = await runSheriffElection(resumedState(), actions, MINUTE);

    expect(result.aborted).toBe(false);
    expect(result.state.sheriffId).toBe('p1');
    expect(result.state.sheriffElectionSuspended).toBeNull();
    expect(result.state.sheriffElectionSettled).toBe(true);
    expect(result.speeches).toEqual([]);
  });

  it('续轮再被打断：警徽流失', async () => {
    const resumingFlags: boolean[] = [];
    const actions = stubActions({
      withdraw: async () => false,
      wolfBlast: async (_wolfId, resuming) => {
        resumingFlags.push(resuming);
        return true;
      },
    });

    const result = await runSheriffElection(resumedState(), actions, MINUTE);

    expect(resumingFlags).toEqual([true]);
    expect(result.aborted).toBe(true);
    expect(result.state.sheriffId).toBeNull();
    expect(result.state.sheriffElectionSuspended).toBeNull();
    // 双爆作废：不会再续一轮，跟走完了一样算落定。
    expect(result.state.sheriffElectionSettled).toBe(true);
  });

  it('昨天上警的人已经出局就不再问他', async () => {
    const state = resumedState();
    const withDead = {
      ...state,
      players: state.players.map((player) =>
        player.id === 'p2' ? { ...player, isAlive: false, deathDay: 1 } : player,
      ),
    };
    const asked: string[] = [];
    const actions = stubActions({
      withdraw: async (playerId) => {
        asked.push(playerId);
        return false;
      },
      wolfBlast: async () => false,
      vote: ballotOf({ p3: 'p1', p4: 'p1', p5: 'p1', p6: 'p1' }),
    });

    const result = await runSheriffElection(withDead, actions, MINUTE);

    expect(asked).toEqual(['p1']);
    expect(result.state.sheriffId).toBe('p1');
  });
});
