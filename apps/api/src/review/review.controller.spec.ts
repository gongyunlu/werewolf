import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { testAppModule } from '../testing/app';
import { reviewFixture } from './testing';
import { REVIEW_QUEUE } from './review-queue';

const TOKEN = 'review-test-token';
process.env.ADMIN_TOKEN = TOKEN;

describe('手动复盘接口', () => {
  let app: INestApplication;
  let stores: Awaited<ReturnType<typeof reviewFixture>>['stores'];
  let state: string | null;
  const retry = jest.fn(async () => {
    state = 'waiting';
  });
  const job = {
    getState: async () => state,
    isFailed: async () => state === 'failed',
    retry,
  };
  const queue = {
    getJob: jest.fn(async () => (state ? job : undefined)),
    add: jest.fn(async () => {
      state ??= 'waiting';
      return job;
    }),
  };

  beforeEach(async () => {
    ({ stores } = await reviewFixture());
    state = null;
    jest.clearAllMocks();
    const module = await testAppModule(stores)
      .overrideProvider(getQueueToken(REVIEW_QUEUE))
      .useValue(queue)
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  it('预览数量和证据字符量，GET 不入队也不记模型调用', async () => {
    const preview = await request(app.getHttpServer())
      .get('/api/games/g/review/preview')
      .expect(200);
    expect(preview.body).toMatchObject({ decisions: 1, players: 2, expectedLogicalCalls: 3 });
    expect(preview.body.evidenceCharacters.decisions).toBeGreaterThan(0);
    const result = await request(app.getHttpServer()).get('/api/games/g/review').expect(200);
    expect(result.body).toEqual({ status: 'not_started', report: null, failure: null });
    expect(queue.add).not.toHaveBeenCalled();
    expect((await stores.observations.read('g'))!.calls).toHaveLength(0);
  });

  it('只有显式带管理令牌触发，重复提交复用同一任务', async () => {
    await request(app.getHttpServer()).post('/api/games/g/review').expect(401);
    expect(queue.add).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      await request(app.getHttpServer())
        .post('/api/games/g/review')
        .set('x-admin-token', TOKEN)
        .expect(201);
    }
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith('review', { gameId: 'g' }, { jobId: 'g', attempts: 1 });
    expect((await stores.games.find('g'))!.status).toBe('finished');
  });

  it('失败报告显示执行失败；手动续跑重试原任务，不清除检查点', async () => {
    state = 'failed';
    const result = await request(app.getHttpServer()).get('/api/games/g/review').expect(200);
    expect(result.body.status).toBe('failed');
    expect(result.body.failure).toContain('不代表玩家表现差');
    await request(app.getHttpServer())
      .post('/api/games/g/review')
      .set('x-admin-token', TOKEN)
      .expect(201);
    expect(retry).toHaveBeenCalledWith('failed');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('不存在、尚未结束的对局拒绝入队', async () => {
    await stores.games.open({ gameId: 'open', boardId: 'test', roster: [] });
    await request(app.getHttpServer())
      .post('/api/games/missing/review')
      .set('x-admin-token', TOKEN)
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/games/open/review')
      .set('x-admin-token', TOKEN)
      .expect(400);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
