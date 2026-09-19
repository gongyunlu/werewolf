import { ballotOf, stubActions, makeState } from '../../testing/fixtures';
import { runExile } from './exile';

/** 当天已经走过的白天发言顺序，23 分的个位 3（单数）顺时针，从 3 号位起。 */
const SPEECH_ORDER = [3, 4, 5, 6, 1, 2];

function stateWithSheriff(playerCount: number, sheriffId: string | null) {
  return { ...makeState(playerCount), sheriffId };
}

describe('放逐', () => {
  it('唯一最高票的人被放逐', async () => {
    const actions = stubActions({
      vote: ballotOf({ p1: 'p3', p2: 'p3', p3: 'p2', p4: 'p3', p5: 'p6', p6: 'p5' }),
    });
    const result = await runExile(stateWithSheriff(6, 'p1'), actions, SPEECH_ORDER);

    expect(result.exiledId).toBe('p3');
    expect(result.state.players.find((player) => player.id === 'p3')).toMatchObject({
      isAlive: false,
      deathDay: 1,
      deathCause: 'execution',
    });
    expect(result.state.players.filter((player) => !player.isAlive)).toHaveLength(1);
  });

  it('警长那一票按 1.5 计', async () => {
    // p2 得警长一票加自己一票共 2.5；p3 得两张普通票共 2，没有加权就是平票。
    const actions = stubActions({
      vote: ballotOf({ p1: 'p2', p2: 'p2', p3: 'p3', p4: 'p3' }),
    });
    const result = await runExile(stateWithSheriff(4, 'p1'), actions, SPEECH_ORDER);

    expect(result.exiledId).toBe('p2');
  });

  it('全员弃票则本轮无人出局', async () => {
    const actions = stubActions({ vote: async () => null });
    const state = stateWithSheriff(6, 'p1');
    const result = await runExile(state, actions, SPEECH_ORDER);

    expect(result.exiledId).toBeNull();
    expect(result.state).toBe(state);
  });

  // 警长投了票，放逐就平不了：1.5 加整数凑不出两个相等的和。平票只能出在没警徽或警长弃票的局。
  it('有没有警长环节不打紧，警徽在不在手上才决定平票能不能出现', async () => {
    // 同一组票：p1 投 p2、p2 与 p3 各得三票，没有加权时正好平。
    const tied = ballotOf({ p1: 'p2', p2: 'p3', p3: 'p2', p4: 'p3', p5: 'p2', p6: 'p3' });

    // 警徽已流失：不加权，平票成立，进 PK 发言。
    const noBadge = await runExile(
      makeState(6),
      stubActions({
        speak: async () => '发言',
        vote: async (turn, playerId) =>
          (turn === 'exile' ? tied : ballotOf({ p1: 'p3', p4: 'p3', p5: 'p3', p6: 'p2' }))(
            turn,
            playerId,
          ),
      }),
      SPEECH_ORDER,
    );
    expect(noBadge.speeches).toHaveLength(2);

    // 警徽在 p1 手上：他那 1.5 票把差额拉开，没有 PK 可打。
    const withBadge = await runExile(
      stateWithSheriff(6, 'p1'),
      stubActions({ vote: tied }),
      SPEECH_ORDER,
    );
    expect(withBadge.exiledId).toBe('p2');
    expect(withBadge.speeches).toEqual([]);
  });

  it('警长弃票时平票照样会出现', async () => {
    // 上一条的前提是警长投了票。弃票让他的 1.5 票不落地，全场票权退回整数。
    const actions = stubActions({
      speak: async () => '发言',
      vote: async (turn, playerId) =>
        (turn === 'exile'
          ? ballotOf({ p1: null, p2: 'p3', p3: 'p2', p4: 'p3', p5: 'p2', p6: null })
          : ballotOf({ p1: 'p3', p4: 'p3', p5: 'p2', p6: 'p2' }))(turn, playerId),
    });
    const result = await runExile(stateWithSheriff(6, 'p1'), actions, SPEECH_ORDER);

    expect(result.exiledId).toBe('p3');
    expect(result.speeches.map((speech) => [speech.turn, speech.seatNo])).toEqual([
      ['exile_pk', 2],
      ['exile_pk', 3],
    ]);
  });

  it('平票时平票者按相反顺序 PK 发言，由非平票的存活玩家再投一次', async () => {
    const actions = stubActions({
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      vote: async (turn, playerId) =>
        (turn === 'exile'
          ? ballotOf({ p1: 'p2', p2: 'p3', p3: 'p2', p4: 'p3', p5: 'p2', p6: 'p3' })
          : // PK 台上只剩 p2、p3，两人都不能投自己。
            ballotOf({ p1: 'p3', p4: 'p3', p5: 'p3', p6: 'p2' }))(turn, playerId),
    });
    const result = await runExile(makeState(6), actions, SPEECH_ORDER);

    expect(result.exiledId).toBe('p3');
    // PK 台上只有 p2、p3，当天顺序里 3 在前，倒过来就是 p2 先发言。
    expect(result.speeches.map((speech) => [speech.turn, speech.seatNo])).toEqual([
      ['exile_pk', 2],
      ['exile_pk', 3],
    ]);
  });

  it('PK 再平票则本轮无人出局', async () => {
    const actions = stubActions({
      speak: async () => '发言',
      vote: async (turn, playerId) =>
        (turn === 'exile'
          ? ballotOf({ p1: 'p2', p2: 'p3', p3: 'p2', p4: 'p3', p5: 'p2', p6: 'p3' })
          : ballotOf({ p1: 'p3', p4: 'p2', p5: 'p3', p6: 'p2' }))(turn, playerId),
    });
    const state = makeState(6);
    const result = await runExile(state, actions, SPEECH_ORDER);

    expect(result.exiledId).toBeNull();
    expect(result.state).toBe(state);
  });

  it('PK 投票也可以弃票', async () => {
    const actions = stubActions({
      speak: async () => '发言',
      vote: async (turn, playerId) =>
        (turn === 'exile'
          ? ballotOf({ p1: 'p2', p2: 'p3', p3: 'p2', p4: 'p3', p5: 'p2', p6: 'p3' })
          : ballotOf({ p1: null, p4: 'p3', p5: 'p3', p6: 'p2' }))(turn, playerId),
    });
    const result = await runExile(makeState(6), actions, SPEECH_ORDER);

    // 弃掉的那张不记给任何人，剩下的票照样选出结果。
    expect(result.exiledId).toBe('p3');
  });

  it('警长被放逐也不动警徽：移交排在死后技能之后，见 loop.settleExile', async () => {
    // 没有配 decideBadge，一旦问到就会失败。
    const actions = stubActions({
      vote: ballotOf({ p1: 'p6', p2: 'p1', p3: 'p1', p4: 'p1', p5: 'p1', p6: 'p2' }),
    });
    const result = await runExile(stateWithSheriff(6, 'p1'), actions, SPEECH_ORDER);

    expect(result.exiledId).toBe('p1');
    expect(result.state.sheriffId).toBe('p1');
  });

  it('出局的不是警长就不动警徽', async () => {
    // 没有配 decideBadge，一旦问到就会失败。
    const actions = stubActions({
      vote: ballotOf({ p1: 'p3', p2: 'p3', p3: 'p2', p4: 'p3', p5: 'p6', p6: 'p5' }),
    });
    const result = await runExile(stateWithSheriff(6, 'p1'), actions, SPEECH_ORDER);

    expect(result.exiledId).toBe('p3');
    expect(result.state.sheriffId).toBe('p1');
  });
});
