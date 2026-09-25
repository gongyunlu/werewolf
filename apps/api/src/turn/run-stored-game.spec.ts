import { ACTION_TYPES, FACTIONS, GAME_STATUSES } from '@werewolf/shared';
import { createGameSetup } from '../boards/setup';
import type { ModelAccess } from '../llm/model-port';
import { memoryStores } from '../store/memory';
import type { GameStores } from '../store/stores';
import { makeState, stubSkills } from '../testing/fixtures';
import { answeringModel, type RecordingModel } from '../testing/model';
import { answeringPlayer, breakingPlayer, playerAnswer } from '../testing/player';
import { LOCAL_TURN_PROMPTS } from './prompt';
import { runStoredGame } from './run-stored-game';

const ACCESS: ModelAccess = {
  baseUrl: 'https://model.example.test/v1',
  model: '用例模型',
  apiKey: 'sk-用例',
  capability: {
    reasoningOff: null,
  },
};

/** 随机源一直取 0：洗牌走同一条确定的路径，对局因此可复现。 */
const RANDOM = () => 0;

/** 另一条确定的洗牌路径，发出来的牌跟上面那条不一样。 */
const OTHER_RANDOM = () => 0.99;

/** 跑一局 g1，把假玩家收到的那一串和结果一起交出来。 */
async function play(
  stores: GameStores,
  options: { model?: RecordingModel; random?: () => number } = {},
) {
  const setup = createGameSetup({
    gameId: 'g1',
    boardId: '12p_wolf_king',
    random: options.random ?? RANDOM,
  });
  const model = options.model ?? answeringPlayer();

  const result = await runStoredGame({
    setup,
    playerIds: setup.seats.map((seat) => `p${seat.seatNo}`),
    runtime: { port: model, accessFor: () => ACCESS, memoriesFor: () => [], skills: stubSkills() },
    promptSource: LOCAL_TURN_PROMPTS,
    minuteOf: () => 0,
    stores,
  });

  return { result, model };
}

/** 盯住建档：接着跑的那一跑不该再立一份档。 */
function countingOpens(stores: GameStores): string[] {
  const opens: string[] = [];
  const open = stores.games.open.bind(stores.games);
  stores.games.open = async (game) => {
    opens.push(game.gameId);
    return open(game);
  };

  return opens;
}

/** 盯住只换状态那一路：终局写在档案上，走到那一步之前推过哪些状态从这里看。 */
function countingStatuses(stores: GameStores): string[] {
  const seen: string[] = [];
  const setStatus = stores.games.setStatus.bind(stores.games);
  stores.games.setStatus = async (gameId, status) => {
    seen.push(status);
    return setStatus(gameId, status);
  };

  return seen;
}

describe('留得住的对局', () => {
  it('日终中断标记失败，恢复只补该日缺失玩家并继续完成正常对局', async () => {
    const stores = memoryStores();
    let failedSeat: string | undefined;
    const model = answeringModel((request) => {
      if (JSON.stringify(request.tool ?? {}).includes('assessment')) {
        const seat = request.system.match(/坐 (\d+) 号/)![1];
        failedSeat ??= seat;
        if (seat === failedSeat) throw new Error('日终模型中断');
      }
      return playerAnswer(request);
    });
    await expect(play(stores, { model })).rejects.toThrow('日终模型中断');
    expect((await stores.games.find('g1'))!.status).toBe(GAME_STATUSES.FAILED);
    const boundary = (await stores.steps.last('g1'))!;
    expect(boundary.phaseInstanceId).toMatch(/\/dayEnd$/);
    const completed = (await stores.actions.list('g1')).filter(
      (row) => row.actionType === ACTION_TYPES.DAY_END_JUDGMENT && row.status === 'done',
    );
    expect(completed.length).toBeGreaterThan(0);

    const resumed = await play(stores);
    const repeatedDay = resumed.model.calls.filter(
      (request) =>
        JSON.stringify(request.tool ?? {}).includes('assessment') &&
        request.prompt.includes(`游戏日 ${boundary.state.day}；`),
    );
    expect(repeatedDay).toHaveLength(1);
    expect(repeatedDay[0].system).toContain(`坐 ${failedSeat} 号`);
    for (const row of completed) expect(await stores.actions.find(row.actionKey)).toEqual(row);
    expect((await stores.games.find('g1'))!.status).toBe(GAME_STATUSES.FINISHED);
    const later = resumed.result.outcomes.filter(
      (outcome) => outcome.snapshot.context.day > boundary.state.day,
    );
    expect(later.some((outcome) => outcome.snapshot.context.previousJudgment)).toBe(true);
  });
  it('库里没有这一局就现开一局：建档、跑完、胜方写回档案', async () => {
    const stores = memoryStores();
    const statuses = countingStatuses(stores);

    const { result } = await play(stores);

    const stored = await stores.games.find('g1');
    expect(stored?.boardId).toBe('12p_wolf_king');
    expect(stored?.winner).toBe(result.winner);
    expect(stored?.status).toBe(GAME_STATUSES.FINISHED);
    expect(stored).toHaveProperty('finalState', result.state);
    // 真跑起来的那一刻要挪出队列：还挂在「排队中」看着像没轮上。
    expect(statuses).toEqual([GAME_STATUSES.RUNNING]);
  });

  it('断了再跑：接着最后一份锚点往下走，答过的那些不再问模型', async () => {
    const stores = memoryStores();
    const opens = countingOpens(stores);
    const clean = await play(memoryStores());

    await expect(
      play(stores, { model: breakingPlayer(Math.floor(clean.model.calls.length * 0.75)) }),
    ).rejects.toThrow('这一跑断在这儿');
    // 断的那一跑连胜方都没写：档案里记着的还是「没分出胜负」。
    const broke = await stores.games.find('g1');
    expect(broke?.winner).toBeNull();
    // 跑崩了要标出来：不标它就一直挂在「运行中」，看着像还在跑。
    expect(broke?.status).toBe(GAME_STATUSES.FAILED);

    // 接着跑那一跑故意换一条洗牌路径：接的要是库里那份局面，这一份发出来的牌根本用不上。
    const resumed = await play(stores, { random: OTHER_RANDOM });

    // 在后半局中断，接着跑只该问剩下来的那一小段。
    expect(resumed.model.calls.length).toBeLessThan(clean.model.calls.length / 2);
    expect(resumed.result.winner).toBe(clean.result.winner);
    expect(resumed.result.state.players.map((player) => player.isAlive)).toEqual(
      clean.result.state.players.map((player) => player.isAlive),
    );
    expect(
      resumed.result.state.players.map((player) => [player.id, player.seatNo, player.role]),
    ).toEqual(clean.result.state.players.map((player) => [player.id, player.seatNo, player.role]));
    // 库里有这一局了，接着跑不再重建一份。
    expect(opens).toEqual(['g1']);
    const stored = await stores.games.find('g1');
    expect(stored?.winner).toBe(resumed.result.winner);
    // 接着跑的那一跑把上一跑留下的 failed 顶掉：它跑完了。
    expect(stored?.status).toBe(GAME_STATUSES.FINISHED);
  });

  it('票型由 Core 交出来记进台账，受众是场上所有人', async () => {
    const stores = memoryStores();

    const { result } = await play(stores);

    // 一轮投票是并发问出去的，各人的落点要等 Core 计完票才知道结果——适配器看不到定局，
    // 这条事实由 Core 在计票后交过来。
    const ballots = (await stores.events.list('g1')).filter((row) =>
      row.text.startsWith('放逐投票'),
    );
    expect(ballots.length).toBeGreaterThan(0);

    const all = result.state.players.map((player) => player.id);
    expect(ballots.every((row) => row.audience.length === all.length)).toBe(true);
  });

  it('票型进了它之后那几问的上下文', async () => {
    const stores = memoryStores();

    const { result } = await play(stores);

    const ballot = (await stores.events.list('g1')).find((row) => row.text.startsWith('放逐投票'));
    expect(ballot).toBeDefined();
    expect(
      result.outcomes.some((outcome) =>
        outcome.snapshot.context.visible.some((block) => block.lines.includes(ballot!.text)),
      ),
    ).toBe(true);
  });

  it('接一局时板子对不上就不跑：技能正文是按这次传的板子现取的', async () => {
    const stores = memoryStores();
    await stores.games.open({ gameId: 'g1', boardId: '6p_white_wolf', roster: [] });
    const model = answeringPlayer();

    await expect(play(stores, { model })).rejects.toThrow('这一局是用 6p_white_wolf 开的');

    expect(model.calls).toHaveLength(0);
  });

  it('档案里记着胜方的局不再跑：一次模型都不问', async () => {
    const stores = memoryStores();
    await stores.games.open({ gameId: 'g1', boardId: '12p_wolf_king', roster: [] });
    await stores.games.finish('g1', FACTIONS.GOOD, makeState(12));
    const model = answeringPlayer();

    await expect(play(stores, { model })).rejects.toThrow('这一局已经分出胜负');

    expect(model.calls).toHaveLength(0);
  });
});
