import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN_TOKEN_HEADER } from '../common/guards/admin-token.guard';
import { memoryStores } from '../store/memory';
import { testAppModule } from '../testing/app';
import { KNOWLEDGE_QUEUE } from './knowledge-queue';
import { INITIAL_KNOWLEDGE } from './initial-content';

describe('知识管理接口', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app?.close();
  });
  it('查看、草稿保存不调用索引；写入鉴权、非法范围和并发编辑冲突清晰返回', async () => {
    process.env.ADMIN_TOKEN = 'knowledge-test-token';
    const stores = memoryStores();
    const queue = { getJob: jest.fn(), add: jest.fn() };
    const module = await testAppModule(stores)
      .overrideProvider(getQueueToken(KNOWLEDGE_QUEUE))
      .useValue(queue)
      .compile();
    app = module.createNestApplication();
    await app.init();
    const api = app.getHttpServer();
    const id = randomUUID();
    const content = INITIAL_KNOWLEDGE[0]!.content;
    const auth = { [ADMIN_TOKEN_HEADER]: process.env.ADMIN_TOKEN! };
    await request(api).put(`/knowledge/${id}/draft`).send({ revision: 0, content }).expect(401);
    await request(api)
      .put(`/knowledge/${id}/draft`)
      .set(auth)
      .send({ revision: 0, content: { ...content, boardIds: ['不存在'] } })
      .expect(400);
    const saved = await request(api)
      .put(`/knowledge/${id}/draft`)
      .set(auth)
      .send({ revision: 0, content })
      .expect(200);
    await request(api).get('/knowledge').expect(200);
    await request(api)
      .get(`/knowledge/versions/${saved.body.versions[0].versionId}/calls`)
      .expect(200, { calls: [] });
    expect(queue.add).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
    await request(api)
      .put(`/knowledge/${id}/draft`)
      .set(auth)
      .send({ revision: 0, content: { ...content, body: '旧编辑' } })
      .expect(409);
    expect((await stores.knowledge.find(id))!.versions).toHaveLength(1);
    await request(api)
      .patch(`/knowledge/${id}/active`)
      .set(auth)
      .send({ revision: saved.body.revision, versionId: null })
      .expect(200);
    await request(api).get('/knowledge/not-uuid').expect(400);
  });
});
