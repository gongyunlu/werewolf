import { GAME_STATUSES } from '@werewolf/shared';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ModelCapability } from '../llm/model-capability';
import type { ModelAccess, ModelPort } from '../llm/model-port';
import { EVENT_KINDS, type StoredEvent } from '../store/events';
import type { RosterSeat } from '../store/games';
import { memoryStores } from '../store/memory';
import type { GameStores } from '../store/stores';
import { answeringPlayer } from '../testing/player';
import { makeState } from '../testing/fixtures';
import { FakeRedis } from '../testing/stream';
import { GameEventHub, PREVIEW_CHANNEL } from './game-event-hub';
import type { GameJob } from './game-queue';
import { GameWorker } from './game-worker';

// 起跑那一头按环境变量拼模型端口，用例里没有密钥。整份替掉，才能从 worker 这一头穿进阵容那条路。
jest.mock('../llm/from-env');

const fromEnv = jest.mocked(jest.requireMock<typeof import('../llm/from-env')>('../llm/from-env'));

/** 没排阵容的那些格子共用的那份：型号与座位那一格分得开，撤了阵容一眼看得出来。 */
const FALLBACK: ModelAccess = {
  baseUrl: 'https://fallback.example.test/v1',
  model: '兜底型号',
  apiKey: 'sk-兜底',
  capability: { reasoningOff: null } satisfies ModelCapability,
};

/** 3 号那一格自己的型号。 */
const SEAT3_MODEL = '三号自己的型号';

// 逐座位那份接入身份按「端点 + 型号」查能力表，用例里这两样得先声明，不然铺阵容那一步就抛。
process.env.MODEL_CAPABILITIES = JSON.stringify([
  { baseUrl: 'https://model.example.test/v1', model: '别人的型号', reasoningOff: null },
  { baseUrl: 'https://model.example.test/v1', model: SEAT3_MODEL, reasoningOff: null },
]);

/** 牌桌上那 6 个人排进阵容：3 号那一格给他一个只属于他的型号。 */
async function seatsOf6(stores: GameStores): Promise<RosterSeat[]> {
  const rows = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((seatNo) =>
      stores.agents.create({
        name: `${seatNo} 号`,
        modelName: seatNo === 3 ? SEAT3_MODEL : '别人的型号',
        baseUrl: null,
        apiKeyCiphertext: null,
        apiKeyHint: null,
        tag: null,
        notes: null,
      }),
    ),
  );

  return rows.map((row, index) => ({
    seatNo: index + 1,
    agentId: row.id,
    name: row.name,
    modelName: row.modelName,
    baseUrl: row.baseUrl,
  }));
}

/**
 * 替身照旧，只把每一次调用用的那份接入身份记下来。
 * 阵容有没有传到起跑那一头，看的正是这个型号。
 */
function recordingPort(inner: ModelPort) {
  const used: { model: string; system: string }[] = [];

  return {
    used,
    port: {
      generate: (request, access, options) => {
        used.push({ model: access.model, system: request.system });
        return inner.generate(request, access, options);
      },
    } satisfies ModelPort,
  };
}

/** 一条事实，用例里只要正文不同。 */
function event(seq: number): StoredEvent {
  return {
    seq,
    eventKey: `k${seq}`,
    day: 1,
    text: `第 ${seq} 条`,
    kind: EVENT_KINDS.OTHER,
    audience: ['p1'],
  };
}

/** 队列递过来的那一格：这一层只读 job.data。 */
const jobOf = (gameId: string) => ({ data: { gameId } }) as Job<GameJob>;

function workerOn(stores: ReturnType<typeof memoryStores>): GameWorker {
  const pub = new FakeRedis();
  const sub = new FakeRedis();

  return new GameWorker(stores, new GameEventHub(pub as unknown as Redis, sub as unknown as Redis));
}

describe('队列上跑对局的那一头', () => {
  it('跑不起来的那一局要标出来：不能一直挂在「排队中」', async () => {
    const stores = memoryStores();
    await stores.games.open({ gameId: 'g1', boardId: '9p_never', roster: [] });

    const worker = workerOn(stores);
    await expect(worker.process(jobOf('g1'))).rejects.toThrow('没有这块板子：9p_never');
    await worker.onFailed(jobOf('g1'), new Error('没有这块板子：9p_never'));

    // 抛在 runStoredGame 之前的那几处没走到它自己那一刀，档案得留个「中断」。
    expect((await stores.games.find('g1'))?.status).toBe(GAME_STATUSES.FAILED);
  });

  it('失锁超限而未进入 process 的任务，也要把运行中的档案标成中断', async () => {
    const stores = memoryStores();
    await stores.games.open({ gameId: 'g1', boardId: '6p_white_wolf', roster: [] });
    await stores.games.setStatus('g1', GAME_STATUSES.RUNNING);

    await workerOn(stores).onFailed(
      jobOf('g1'),
      new Error('job stalled more than allowable limit'),
    );

    expect((await stores.games.find('g1'))?.status).toBe(GAME_STATUSES.FAILED);
  });

  it('失败事件没有对应任务或档案时，只记录错误', async () => {
    const stores = memoryStores();
    const worker = workerOn(stores);

    await expect(worker.onFailed(undefined, new Error('任务已移除'))).resolves.toBeUndefined();
    await expect(worker.onFailed(jobOf('missing'), new Error('没有档案'))).resolves.toBeUndefined();
    expect(await stores.games.list()).toEqual([]);
  });

  it('队列里那局没有档案就抛，不现立一份', async () => {
    const stores = memoryStores();

    await expect(workerOn(stores).process(jobOf('g1'))).rejects.toThrow('队列里这一局没有档案');

    // 没档案就没有可标的地方：这一刀要是先落下去，抛出来的会是「没立过档就直接改状态」。
    expect(await stores.games.find('g1')).toBeNull();
  });

  it('推不出去不耽误记账：台账里照样有这一条', async () => {
    const stores = memoryStores();
    const hub = {
      publish: () => Promise.reject(new Error('Redis 掉了')),
    } as unknown as GameEventHub;
    const worker = new GameWorker(stores, hub);

    // 中转是私有的，用例借它的外壳拿那份包过的存储：要看的正是包在外面这一层。
    const wrapped = (worker as unknown as { stores: GameStores }).stores;
    await wrapped.events.append('g1', event(1));

    expect(await stores.events.list('g1')).toHaveLength(1);
  });

  it('开局排的那份阵容在队列这一头也算数：谁在答就用谁那份型号', async () => {
    const stores = memoryStores();
    const { port, used } = recordingPort(answeringPlayer());
    fromEnv.modelRuntimeOf.mockReturnValue({ port, access: FALLBACK });
    // 平台读不到就退本地模板，这条路一样走得通。
    fromEnv.promptSourceOf.mockReturnValue({
      load: () => Promise.reject(new Error('用例不取远端提示词')),
    });

    await stores.games.open({
      gameId: 'g1',
      boardId: '6p_white_wolf',
      roster: await seatsOf6(stores),
    });
    await workerOn(stores).process(jobOf('g1'));

    // 撤掉 worker 里那一行 roster，整局都会退回兜底那份，这一条当场红。
    const ours = used.filter((call) => call.system.includes('坐 3 号'));
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.map((call) => call.model)).toEqual(ours.map(() => SEAT3_MODEL));
  });

  it('正在写的那一段推给了中转：观战页上的字是从这一条走的', async () => {
    const stores = memoryStores();
    const inner = answeringPlayer();
    fromEnv.modelRuntimeOf.mockReturnValue({
      // 真端口接了 onDelta 就边走边吐，这儿照做：不吐的话 worker 那条线一次都走不到。
      port: {
        generate: (request, access, options) => {
          options?.onDelta?.({ channel: 'reasoning', text: '想一下' });
          return inner.generate(request, access, options);
        },
      },
      access: FALLBACK,
    });
    fromEnv.promptSourceOf.mockReturnValue({
      load: () => Promise.reject(new Error('用例不取远端提示词')),
    });
    await stores.games.open({ gameId: 'g1', boardId: '6p_white_wolf', roster: [] });

    const pub = new FakeRedis();
    const worker = new GameWorker(
      stores,
      new GameEventHub(pub as unknown as Redis, new FakeRedis() as unknown as Redis),
    );
    await worker.process(jobOf('g1'));

    // 推错频道等于没推：落在事实那条上的预览，前端按事实解不出来，会被静默丢掉。
    expect(pub.channels).toContain(PREVIEW_CHANNEL);
  });

  it('跑完的那一局再被投一次：照抛不误，但档案上的「已结束」不能被改回去', async () => {
    const stores = memoryStores();
    await stores.games.open({ gameId: 'g1', boardId: '6p_white_wolf', roster: [] });
    await stores.games.finish('g1', 'werewolf', makeState(6));

    // 用例里没有密钥，这一跑停在供应商那一步，走不到 runStoredGame；要看的只是
    // 「替一局已经把胜负写完的对局扣上中断」这件事有没有发生。
    const worker = workerOn(stores);
    await expect(worker.process(jobOf('g1'))).rejects.toThrow();
    await worker.onFailed(jobOf('g1'), new Error('这一局已经分出胜负'));

    expect((await stores.games.find('g1'))?.status).toBe(GAME_STATUSES.FINISHED);
  });
});
