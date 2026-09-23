import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { DEATH_CAUSES, GAME_STATUSES, type PreviewChunk } from '@werewolf/shared';
import request from 'supertest';
import { testAppModule } from '../testing/app';
import { createGameSetup } from '../boards/setup';
import type { BoardId } from '../boards/boards';
import { ADMIN_TOKEN_HEADER } from '../common/guards/admin-token.guard';
import { nextPhaseInstanceId } from '../core/identity';
import { createGameState, patchPlayer, type GameState } from '../core/state';
import { PREVIEW_CHANNEL, REDIS_SUB } from '../queue/game-event-hub';
import { GAME_QUEUE, type GameJob } from '../queue/game-queue';
import { EVENT_KINDS, type StoredEvent } from '../store/events';
import { memoryStores } from '../store/memory';
import type { GameStores } from '../store/stores';
import { FakeRedis, take } from '../testing/stream';
import { makeState } from '../testing/fixtures';
import { GamesController } from './games.controller';

/** 用例里的管理令牌。构造时才读环境，这一行在各用例之前就位即可。 */
const TOKEN = 'test-admin-token';
process.env.ADMIN_TOKEN = TOKEN;

/** 开局与续跑都要带它，用例里默认带上那把对的。 */
function admin(token: string = TOKEN) {
  return { [ADMIN_TOKEN_HEADER]: token };
}

/** 入队那一头：用例只关心「拿什么入的队」，不真往队列里放东西。 */
interface Enqueued {
  name: string;
  data: GameJob;
  opts: { jobId?: string } | undefined;
}

let stores: GameStores;
let added: Enqueued[];
let sub: FakeRedis;
let app: INestApplication;
/** 队列里挂着的那一份，续跑那一头要看它一眼。用例按需要摆一个上去。 */
let hanging: { active: boolean; removed: boolean } | undefined;

/** 立一局档，顺带落一份锚点：详情里那张牌桌是从锚点读的。 */
async function open(gameId: string, boardId: BoardId = '6p_white_wolf') {
  await stores.games.open({ gameId, boardId, roster: [] });
  const setup = createGameSetup({ gameId, boardId, random: () => 0 });
  const state = createGameState(
    setup,
    setup.seats.map((seat) => `p${seat.seatNo}`),
  );
  await stores.steps.append(gameId, { phaseInstanceId: state.phaseInstanceId, state, input: {} });
}

/**
 * 排一队 agent 出来。走存储那一层，不绕接口——用例要的是「已经排好的那几个人」。
 * 第一个带接入端点，用来验它不出现在详情里。名字带个队号：同一个用例文件里要排好几队。
 */
let lineupNo = 0;
async function lineup(seats: number) {
  const team = `第${(lineupNo += 1)}队`;
  const agents = [];
  for (const seatNo of Array.from({ length: seats }, (_, index) => index + 1)) {
    agents.push(
      await stores.agents.create({
        name: `${team}${seatNo}号`,
        modelName: `m-${seatNo}`,
        baseUrl: seatNo === 1 ? 'https://a.example.test/v1' : null,
        apiKeyCiphertext: null,
        apiKeyHint: null,
        tag: null,
        notes: null,
      }),
    );
  }

  return agents;
}

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

/** 正在写的那一片。观战那头发的是它本身，不带序号也不带幂等键。 */
function chunk(text: string): PreviewChunk {
  return {
    actionKey: 'test-action',
    day: 1,
    seatNo: 1,
    actionType: 'speech',
    step: 'generate',
    callId: 'c1',
    channel: 'content',
    text,
  };
}

describe('对局接口', () => {
  beforeAll(async () => {
    stores = memoryStores();
    added = [];
    sub = new FakeRedis();

    const moduleRef = await testAppModule(stores)
      .overrideProvider(getQueueToken(GAME_QUEUE))
      .useValue({
        add: async (name: string, data: GameJob, opts: Enqueued['opts']) => {
          added.push({ name, data, opts });
        },
        getJob: async () => {
          const job = hanging;
          if (job === undefined) return undefined;

          return {
            isActive: () => Promise.resolve(job.active),
            remove: () => {
              job.removed = true;
              return Promise.resolve();
            },
          };
        },
      })
      .overrideProvider(REDIS_SUB)
      .useValue(sub)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('列表把档案那几项摊出来，新开的在前', async () => {
    await stores.games.open({ gameId: 'g-old', boardId: '12p_wolf_king', roster: [] });
    await stores.games.open({ gameId: 'g-new', boardId: '6p_white_wolf', roster: [] });
    await stores.games.finish('g-new', 'werewolf', { ...makeState(6), gameId: 'g-new' });

    const { body } = await request(app.getHttpServer()).get('/api/games').expect(200);

    const ids = body.games.map((game: { gameId: string }) => game.gameId);
    expect(ids.indexOf('g-new')).toBeLessThan(ids.indexOf('g-old'));
    expect(body.games.find((game: { gameId: string }) => game.gameId === 'g-new')).toEqual({
      gameId: 'g-new',
      boardId: '6p_white_wolf',
      status: GAME_STATUSES.FINISHED,
      winner: 'werewolf',
      createdAt: expect.any(String),
      aliveCount: 6,
      day: 1,
    });
  });

  it('列表带上活着的人与第几天：取的是每局最后落的那一份', async () => {
    await open('g-six');
    await open('g-twelve', '12p_wolf_king');
    await stores.games.open({ gameId: 'g-没发牌', boardId: '6p_white_wolf', roster: [] });

    // 6 人那局再走一格：少一个人、进第二天。列表要认后落这份。
    const anchor = await stores.steps.last('g-six');
    if (!anchor) throw new Error('用例里没有锚点');
    const state: GameState = {
      ...anchor.state,
      day: 2,
      players: anchor.state.players.map((player) =>
        player.seatNo === 4
          ? { ...player, isAlive: false, deathDay: 1, deathCause: DEATH_CAUSES.NIGHT_KILL }
          : player,
      ),
    };
    await stores.steps.append('g-six', {
      phaseInstanceId: nextPhaseInstanceId(state.phaseInstanceId, 'vote'),
      state,
      input: {},
    });

    const { body } = await request(app.getHttpServer()).get('/api/games').expect(200);
    const found = new Map((body.games as { gameId: string }[]).map((game) => [game.gameId, game]));

    expect(found.get('g-six')).toMatchObject({ aliveCount: 5, day: 2 });
    // 逐局各认自己那份：12 人那局不能跟着变成 5，6 人那局也不能算成 12。
    expect(found.get('g-twelve')).toMatchObject({ aliveCount: 12, day: 1 });
    expect(found.get('g-没发牌')).toMatchObject({ aliveCount: null, day: null });
  });

  it('终局列表和详情使用最终局面，恢复锚点保持原样', async () => {
    await open('g-final');
    const anchor = (await stores.steps.last('g-final'))!;
    const finalState = {
      ...patchPlayer(anchor.state, 'p1', {
        isAlive: false,
        deathDay: 2,
        deathCause: DEATH_CAUSES.EXECUTION,
      }),
      day: 2,
      sheriffId: 'p2',
    };
    await stores.games.finish('g-final', 'werewolf', finalState);

    const detail = await request(app.getHttpServer()).get('/api/games/g-final').expect(200);
    expect(detail.body.game).toMatchObject({ aliveCount: 5, day: 2 });
    expect(detail.body.game.players[0]).toMatchObject({ isAlive: false, deathDay: 2 });
    expect(detail.body.game.players[1]).toMatchObject({ isSheriff: true });
    const list = await request(app.getHttpServer()).get('/api/games').expect(200);
    expect(
      list.body.games.find((game: { gameId: string }) => game.gameId === 'g-final'),
    ).toMatchObject({ aliveCount: 5, day: 2 });
    expect(await stores.steps.last('g-final')).toEqual(anchor);
  });

  it('开一局：先立档，再把这一局的 id 放进队', async () => {
    added = [];

    const { body } = await request(app.getHttpServer())
      .post('/api/games')
      .set(admin())
      .send({ boardId: '6p_white_wolf' })
      .expect(201);

    const stored = await stores.games.find(body.gameId);
    expect(stored).toMatchObject({
      gameId: body.gameId,
      boardId: '6p_white_wolf',
      status: GAME_STATUSES.QUEUED,
      winner: null,
    });
    // 板子只从档案里读：任务里再带一份，两处迟早对不上。
    expect(added).toEqual([
      { name: 'run', data: { gameId: body.gameId }, opts: { jobId: body.gameId } },
    ]);
  });

  // 开一局就是几十次模型调用，谁都能开等于谁都能花这笔钱。
  it('不带管理令牌开不了局，档案不立、队也不入', async () => {
    added = [];

    await request(app.getHttpServer())
      .post('/api/games')
      .send({ boardId: '6p_white_wolf' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/games')
      .set(admin('another-token'))
      .send({ boardId: '6p_white_wolf' })
      .expect(401);

    expect(added).toEqual([]);
  });

  it('续跑同样要令牌', async () => {
    added = [];
    hanging = undefined;
    await open('g-token');

    await request(app.getHttpServer()).post('/api/games/g-token/run').expect(401);

    expect(added).toEqual([]);
  });

  it('本机没配 ADMIN_TOKEN 时开不了局：报的是服务没配好，不是内部错误', async () => {
    added = [];
    process.env.ADMIN_TOKEN = '';

    try {
      const { body } = await request(app.getHttpServer())
        .post('/api/games')
        .send({ boardId: '6p_white_wolf' })
        .expect(503);

      expect(body.message).toContain('ADMIN_TOKEN');
      expect(added).toEqual([]);
    } finally {
      process.env.ADMIN_TOKEN = TOKEN;
    }
  });

  it.each([0, 0.999999])('开局随机排座，续跑保持阵容；随机源 %s', async (randomValue) => {
    const agents = await lineup(6);
    const random = jest.spyOn(Math, 'random').mockReturnValue(randomValue);
    try {
      const { body } = await request(app.getHttpServer())
        .post('/api/games')
        .set(admin())
        .send({ boardId: '6p_white_wolf', agentIds: agents.map((agent) => agent.id) })
        .expect(201);

      const assigned = randomValue === 0 ? [...agents.slice(1), agents[0]] : agents;
      const stored = await stores.games.find(body.gameId);
      expect(stored?.roster).toEqual(
        assigned.map((agent, index) => ({
          seatNo: index + 1,
          agentId: agent.id,
          name: agent.name,
          modelName: agent.modelName,
          baseUrl: agent.baseUrl,
        })),
      );

      const { body: detail } = await request(app.getHttpServer())
        .get(`/api/games/${body.gameId}`)
        .expect(200);
      expect(detail.game.roster).toEqual(
        assigned.map((agent, index) => ({
          seatNo: index + 1,
          agentId: agent.id,
          name: agent.name,
          modelName: agent.modelName,
        })),
      );
      // 端点只在服务端算接入身份时用，不该顺着详情漏出去。
      expect(JSON.stringify(detail)).not.toContain('a.example.test');
      random.mockReturnValue(randomValue === 0 ? 0.999999 : 0);
      hanging = undefined;
      await request(app.getHttpServer())
        .post(`/api/games/${body.gameId}/run`)
        .set(admin())
        .expect(201);
      expect((await stores.games.find(body.gameId))?.roster).toEqual(stored?.roster);
    } finally {
      random.mockRestore();
    }
  });

  it('不给 agent 就是整局走环境变量那一套，阵容是空的', async () => {
    const { body } = await request(app.getHttpServer())
      .post('/api/games')
      .set(admin())
      .send({ boardId: '6p_white_wolf' })
      .expect(201);

    expect((await stores.games.find(body.gameId))?.roster).toEqual([]);
    const { body: detail } = await request(app.getHttpServer())
      .get(`/api/games/${body.gameId}`)
      .expect(200);
    expect(detail.game.roster).toEqual([]);
  });

  it('人数对不上这块板子就不收，档案也不立', async () => {
    added = [];
    const agents = await lineup(5);

    const { body } = await request(app.getHttpServer())
      .post('/api/games')
      .set(admin())
      .send({ boardId: '6p_white_wolf', agentIds: agents.map((agent) => agent.id) })
      .expect(400);

    expect(body.message).toContain('6');
    expect(added).toEqual([]);
  });

  it('排进来的人不存在、或者已经停用，都挡在门外', async () => {
    added = [];
    const agents = await lineup(6);
    await stores.agents.update(agents[5].id, { isActive: false });

    const ids = agents.map((agent) => agent.id);
    await request(app.getHttpServer())
      .post('/api/games')
      .set(admin())
      .send({ boardId: '6p_white_wolf', agentIds: [...ids.slice(0, 5), '没这个人'] })
      .expect(400);
    const { body } = await request(app.getHttpServer())
      .post('/api/games')
      .set(admin())
      .send({ boardId: '6p_white_wolf', agentIds: ids })
      .expect(400);

    expect(body.message).toContain('停用');
    expect(added).toEqual([]);
  });

  it('没有这块板子就挡在门外，档案也不立', async () => {
    added = [];

    await request(app.getHttpServer())
      .post('/api/games')
      .set(admin())
      .send({ boardId: '6p_没有这一块' })
      .expect(400);

    expect(added).toEqual([]);
  });

  it('请求体不合契约也报 400：缺字段是客户端的事，不是服务端出错', async () => {
    added = [];

    await request(app.getHttpServer()).post('/api/games').set(admin()).send({}).expect(400);
    await request(app.getHttpServer())
      .post('/api/games')
      .set(admin())
      .send({ boardId: 123 })
      .expect(400);

    expect(added).toEqual([]);
  });

  it('详情带上上帝视角那张牌桌：座位、牌、阵营、生死', async () => {
    await open('g-detail');

    const { body } = await request(app.getHttpServer()).get('/api/games/g-detail').expect(200);

    expect(body.game.boardId).toBe('6p_white_wolf');
    expect(body.game.players).toHaveLength(6);
    expect(body.game.players[0]).toEqual({
      id: 'p1',
      seatNo: 1,
      role: expect.any(String),
      faction: expect.any(String),
      isAlive: true,
      deathDay: null,
      deathCause: null,
      isSheriff: false,
    });
  });

  it('出局的人带上天数与死因，警长标在他那一格', async () => {
    await open('g-seats');
    const anchor = await stores.steps.last('g-seats');
    if (!anchor) throw new Error('用例里没有锚点');

    // 再落一份：牌桌读的是最后一份，后落这份才看得到出局与警长。
    const state: GameState = {
      ...anchor.state,
      sheriffId: 'p2',
      players: anchor.state.players.map((player) =>
        player.seatNo === 3
          ? { ...player, isAlive: false, deathDay: 2, deathCause: DEATH_CAUSES.EXECUTION }
          : player,
      ),
    };
    await stores.steps.append('g-seats', {
      phaseInstanceId: nextPhaseInstanceId(state.phaseInstanceId, 'vote'),
      state,
      input: {},
    });

    const { body } = await request(app.getHttpServer()).get('/api/games/g-seats').expect(200);
    const bySeat = new Map(
      (body.game.players as { seatNo: number }[]).map((player) => [player.seatNo, player]),
    );

    expect(bySeat.get(2)).toMatchObject({ isSheriff: true });
    expect(bySeat.get(1)).toMatchObject({ isAlive: true, deathDay: null, deathCause: null });
    expect(bySeat.get(1)).toMatchObject({ isSheriff: false });
    expect(bySeat.get(3)).toMatchObject({
      isAlive: false,
      deathDay: 2,
      deathCause: DEATH_CAUSES.EXECUTION,
    });
  });

  it('续跑：队列里那份清掉重排，状态退回排队中', async () => {
    added = [];
    hanging = { active: false, removed: false };
    // 断了的那一局留在「运行中」：不退回排队中，看的人会以为这次没排上。
    await open('g-resume');
    await stores.games.setStatus('g-resume', GAME_STATUSES.RUNNING);

    const { body } = await request(app.getHttpServer())
      .post('/api/games/g-resume/run')
      .set(admin())
      .expect(201);

    expect(body).toEqual({ gameId: 'g-resume' });
    expect(hanging.removed).toBe(true);
    expect(added).toEqual([
      { name: 'run', data: { gameId: 'g-resume' }, opts: { jobId: 'g-resume' } },
    ]);
    expect((await stores.games.find('g-resume'))?.status).toBe(GAME_STATUSES.QUEUED);
  });

  it('队列里那份还在跑就拦下，不重排', async () => {
    added = [];
    hanging = { active: true, removed: false };
    await open('g-running');

    const { body } = await request(app.getHttpServer())
      .post('/api/games/g-running/run')
      .set(admin())
      .expect(400);

    expect(body.message).toContain('正在跑');
    expect(hanging.removed).toBe(false);
    expect(added).toEqual([]);
  });

  it('已经分出胜负的那一局不再重排', async () => {
    added = [];
    hanging = undefined;
    await stores.games.open({ gameId: 'g-over', boardId: '6p_white_wolf', roster: [] });
    await stores.games.finish('g-over', 'werewolf', { ...makeState(6), gameId: 'g-over' });

    await request(app.getHttpServer()).post('/api/games/g-over/run').set(admin()).expect(400);

    expect(added).toEqual([]);
  });

  it('续跑一局不存在的，报的是没这一局', async () => {
    added = [];
    hanging = undefined;

    await request(app.getHttpServer())
      .post('/api/games/g-none-at-all/run')
      .set(admin())
      .expect(404);

    expect(added).toEqual([]);
  });

  it('没有这一局就是 404', async () => {
    await request(app.getHttpServer()).get('/api/games/g-none').expect(404);
  });

  it('事件流：补完台账里积压的，再跟上频道上新到的', async () => {
    const gameId = 'g-stream';
    await stores.events.append(gameId, event(1));

    const messages = take(app.get(GamesController).events(gameId, undefined), 2);
    sub.deliver({
      gameId,
      event: { seq: 2, day: 1, kind: EVENT_KINDS.OTHER, text: '第 2 条', audience: ['p1'] },
    });

    // 用 toStrictEqual：toEqual 认不出多出来的 undefined 属性，幂等键要是留着就漏过去了。
    expect(await messages).toStrictEqual([
      {
        data: { seq: 1, day: 1, kind: EVENT_KINDS.OTHER, text: '第 1 条', audience: ['p1'] },
        id: '1',
      },
      {
        data: { seq: 2, day: 1, kind: EVENT_KINDS.OTHER, text: '第 2 条', audience: ['p1'] },
        id: '2',
      },
    ]);
  });

  it('正在生成的那一段另起一个事件名，带的是事实走到哪一条', async () => {
    const gameId = 'g-preview';
    const messages = take(app.get(GamesController).events(gameId, undefined), 2);

    sub.deliver({ gameId, preview: chunk('我坐') }, PREVIEW_CHANNEL);
    await stores.events.append(gameId, event(1));
    sub.deliver({
      gameId,
      event: { seq: 1, day: 1, kind: EVENT_KINDS.OTHER, text: '第 1 条', audience: ['p1'] },
    });

    // 预览那条的 id 是「事实已经发到哪一条」，不是它自己的序号（它没有序号）。一条事实都还没发时是 0。
    expect(await messages).toStrictEqual([
      { data: chunk('我坐'), type: 'preview', id: '0' },
      {
        data: { seq: 1, day: 1, kind: EVENT_KINDS.OTHER, text: '第 1 条', audience: ['p1'] },
        id: '1',
      },
    ]);
  });

  it('预览比事实后到：它的 id 跟着涨，断点不会落在预览身上', async () => {
    const gameId = 'g-preview-late';
    await stores.events.append(gameId, event(1));
    await stores.events.append(gameId, event(2));

    const messages = take(app.get(GamesController).events(gameId, undefined), 3);
    // 等台账那两条补完：读库是异步的，同一刻推上去的预览会抢在它们前头。
    await new Promise((resolve) => setTimeout(resolve, 0));
    sub.deliver({ gameId, preview: chunk('我坐') }, PREVIEW_CHANNEL);

    // id 不能省：省了 Nest 会给它补一个每连接自增的号，前端拿那个报断点会把之后的事实全挡掉。
    expect(await messages).toStrictEqual([
      {
        data: { seq: 1, day: 1, kind: EVENT_KINDS.OTHER, text: '第 1 条', audience: ['p1'] },
        id: '1',
      },
      {
        data: { seq: 2, day: 1, kind: EVENT_KINDS.OTHER, text: '第 2 条', audience: ['p1'] },
        id: '2',
      },
      { data: chunk('我坐'), type: 'preview', id: '2' },
    ]);
  });
});
