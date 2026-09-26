import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { testAppModule } from '../testing/app';
import { ADMIN_TOKEN_HEADER } from '../common/guards/admin-token.guard';
import { reviewFixture, fakeReviewPlatform } from '../review/testing';
import { runReview } from '../review/workflow';
import { ExperienceController } from './experience.controller';
import { EXPERIENCE_QUEUE } from './experience-queue';
import { fixture, result, access, promptSource, controlledPort } from './testing';
import { runExperience } from './workflow';
import { indexExperience } from './indexing';
import { vectorRuntime } from './testing';

describe('个人经验接口', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app?.close();
  });
  it('已提炼的旧任务能明确补建索引，查看不发请求，完成后重复提交不再入队', async () => {
    const f = await fixture();
    await runExperience(f.stores, f.row.id, {
      port: controlledPort(JSON.stringify(result)),
      access,
      promptSource,
      prepare: f.prepare,
    });
    const job = { getState: async () => 'completed', remove: jest.fn() };
    const queue = { getJob: jest.fn(async () => job), add: jest.fn() };
    const controller = new ExperienceController(f.stores, queue as never);
    expect((await controller.read(f.gameId, 'p1')).status).toBe('not_indexed');
    expect(queue.add).not.toHaveBeenCalled();
    await controller.start(f.gameId, 'p1');
    expect(job.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    const embedding = vectorRuntime();
    await indexExperience(f.stores, f.row.id, embedding);
    expect((await controller.read(f.gameId, 'p1')).status).toBe('completed');
    await controller.start(f.gameId, 'p1');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(embedding.port.generate).toHaveBeenCalledTimes(1);
  });
  it('读取失败任务时展示原始引用错误，不被后续请求失败覆盖', async () => {
    const f = await fixture();
    await f.stores.experiences.save(f.row, {
      ...f.row.state,
      status: 'failed',
      failure: '请求次数已用完',
      attempts: [
        { callId: '错误输出', status: 'invalid', diagnosis: 'sourceIds 必须来自给定原始证据' },
        { callId: '未发出', status: 'failed' },
      ],
    });
    const queue = { getJob: jest.fn(async () => undefined) };
    const controller = new ExperienceController(f.stores, queue as never);
    expect((await controller.read(f.gameId, 'p1')).reason).toBe(
      '请求次数已用完；最近输出校验：sourceIds 必须来自给定原始证据',
    );
    expect((await f.stores.experiences.findGeneration(f.row.id))!.state.failure).toBe(
      '请求次数已用完',
    );
  });
  it('只读不生成；重复提交同一任务；保存后可查看、启停和追溯', async () => {
    const f = await fixture();
    const jobs = new Map<
      string,
      { getState: () => Promise<string>; isFailed: () => Promise<boolean> }
    >();
    const add = jest.fn(async (_name, _data, opts) => {
      jobs.set(opts.jobId, { getState: async () => 'waiting', isFailed: async () => false });
    });
    const queue = { getJob: async (id: string) => jobs.get(id), add };
    const module = await testAppModule(f.stores)
      .overrideProvider(getQueueToken(EXPERIENCE_QUEUE))
      .useValue(queue)
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    process.env.ADMIN_TOKEN = 'test-admin-token';
    const url = `/api/games/${f.gameId}/experience/p1`;
    await request(app.getHttpServer()).get(url).expect(200);
    expect(add).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post(url).expect(401);
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .post(url)
        .set(ADMIN_TOKEN_HEADER, 'test-admin-token')
        .expect(201);
    expect(add).toHaveBeenCalledTimes(1);
    await runExperience(f.stores, f.row.id, {
      port: controlledPort(JSON.stringify(result)),
      access,
      promptSource,
      prepare: f.prepare,
    });
    const { body } = await request(app.getHttpServer())
      .get(`/api/agents/${f.agent.id}/experiences`)
      .expect(200);
    const item = body.experiences[0];
    const toggleUrl = `/api/agents/${f.agent.id}/experiences/${item.id}`;
    await request(app.getHttpServer())
      .patch(toggleUrl)
      .set(ADMIN_TOKEN_HEADER, 'test-admin-token')
      .send({ enabled: 'yes' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(toggleUrl)
      .set(ADMIN_TOKEN_HEADER, 'test-admin-token')
      .send({ enabled: false })
      .expect(200);
    expect((await f.stores.experiences.list(f.agent.id))[0]!.enabled).toBe(false);
    const detail = await request(app.getHttpServer())
      .get(`/api/experiences/generations/${f.row.id}`)
      .expect(200);
    expect(detail.body.generation.sources[0].value).toBe('原始发言中的时序');
    expect(detail.body.generation.calls).toHaveLength(1);
    await request(app.getHttpServer())
      .post(url)
      .set(ADMIN_TOKEN_HEADER, 'test-admin-token')
      .expect(201);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('从完成复盘建立持久归属，没有绑定的历史玩家不可生成', async () => {
    const f = await fixture();
    const gameId = `${f.gameId}-new`;
    await f.stores.games.open({ gameId, boardId: 'test', roster: [f.seat] });
    await reviewFixture(gameId, f.stores);
    const { platform } = fakeReviewPlatform();
    const queue = { getJob: jest.fn(async () => undefined), add: jest.fn() };
    const controller = new ExperienceController(f.stores, queue as never);
    expect((await controller.read(gameId, 'p1')).reason).toBe('请先完成本局复盘');
    await runReview(f.stores, gameId, platform);
    await controller.start(gameId, 'p1');
    const generation = (await controller.read(gameId, 'p1')).generation!;
    expect(generation.agentId).toBe(f.agent.id);
    expect((await controller.read(gameId, 'p2')).reason).toContain('没有绑定');
    await expect(controller.start(gameId, 'p2')).rejects.toThrow('没有绑定');
  });
});
