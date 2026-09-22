import { FACTIONS } from '@werewolf/shared';
import { createGameSetup } from '../boards/setup';
import type { ModelAccess } from '../llm/model-port';
import { memoryStores } from '../store/memory';
import type { GameStores } from '../store/stores';
import { stubSkills } from '../testing/fixtures';
import type { RecordingModel } from '../testing/model';
import { answeringPlayer, breakingPlayer } from '../testing/player';
import { LOCAL_TURN_PROMPTS } from './prompt';
import { runStoredGame } from './run-stored-game';

const ACCESS: ModelAccess = {
  baseUrl: 'https://model.example.test/v1',
  model: '用例模型',
  apiKey: 'sk-用例',
  capability: {
    allowCodeFence: false,
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
    runtime: { port: model, access: ACCESS, skills: stubSkills() },
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

describe('留得住的对局', () => {
  it('库里没有这一局就现开一局：建档、跑完、胜方写回档案', async () => {
    const stores = memoryStores();

    const { result } = await play(stores);

    const stored = await stores.games.find('g1');
    expect(stored?.boardId).toBe('12p_wolf_king');
    expect(stored?.winner).toBe(result.winner);
  });

  it('断了再跑：接着最后一份锚点往下走，答过的那些不再问模型', async () => {
    const stores = memoryStores();
    const opens = countingOpens(stores);
    const clean = await play(memoryStores());

    await expect(play(stores, { model: breakingPlayer(400) })).rejects.toThrow('这一跑断在这儿');
    // 断的那一跑连胜方都没写：档案里记着的还是「没分出胜负」。
    expect((await stores.games.find('g1'))?.winner).toBeNull();

    // 接着跑那一跑故意换一条洗牌路径：接的要是库里那份局面，这一份发出来的牌根本用不上。
    const resumed = await play(stores, { random: OTHER_RANDOM });

    // 整局五百多次调用，断在第四百次上：接着跑只该问剩下来的那一小段。
    expect(resumed.model.calls.length).toBeLessThan(clean.model.calls.length / 2);
    expect(resumed.result.winner).toBe(clean.result.winner);
    expect(resumed.result.state.players.map((player) => player.isAlive)).toEqual(
      clean.result.state.players.map((player) => player.isAlive),
    );
    // 库里有这一局了，接着跑不再重建一份。
    expect(opens).toEqual(['g1']);
    expect((await stores.games.find('g1'))?.winner).toBe(resumed.result.winner);
  });

  it('票型由 Core 交出来记进台账，受众是场上所有人', async () => {
    const stores = memoryStores();

    const { result } = await play(stores);

    // 一轮投票是并发问出去的，各人的落点要等 Core 计完票才知道结果——适配器看不到定局，
    // 这条事实只能由它从 onFacts 交过来。
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
    await stores.games.open({ gameId: 'g1', boardId: '6p_white_wolf' });
    const model = answeringPlayer();

    await expect(play(stores, { model })).rejects.toThrow('这一局是用 6p_white_wolf 开的');

    expect(model.calls).toHaveLength(0);
  });

  it('档案里记着胜方的局不再跑：一次模型都不问', async () => {
    const stores = memoryStores();
    await stores.games.open({ gameId: 'g1', boardId: '12p_wolf_king' });
    await stores.games.finish('g1', FACTIONS.GOOD);
    const model = answeringPlayer();

    await expect(play(stores, { model })).rejects.toThrow('这一局已经分出胜负');

    expect(model.calls).toHaveLength(0);
  });
});
