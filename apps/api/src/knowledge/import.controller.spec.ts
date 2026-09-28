import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN_TOKEN_HEADER } from '../common/guards/admin-token.guard';
import { testAppModule } from '../testing/app';
import { KNOWLEDGE_IMPORT_QUEUE } from './import-queue';
import { KNOWLEDGE_QUEUE } from './knowledge-queue';
import { importFixture } from './import-testing';
import { organizeKnowledgePage } from './import-workflow';
import { KnowledgeImportController } from './import.controller';
import * as embedding from '../llm/embedding';
import { vectorRuntime } from '../experience/testing';

describe('网页采集管理接口', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });
  it('管理入口鉴权；采集只入队；非法来源被拒绝；逐项保存幂等，批量操作分别报告失败', async () => {
    process.env.ADMIN_TOKEN = 'import-test-token';
    const f = await importFixture();
    await organizeKnowledgePage(f.stores, f.id, f.runtime);
    const queue = { getJob: jest.fn(), add: jest.fn() };
    const indexQueue = { getJob: jest.fn(), add: jest.fn() };
    const module = await testAppModule(f.stores)
      .overrideProvider(getQueueToken(KNOWLEDGE_IMPORT_QUEUE))
      .useValue(queue)
      .overrideProvider(getQueueToken(KNOWLEDGE_QUEUE))
      .useValue(indexQueue)
      .compile();
    app = module.createNestApplication();
    await app.init();
    const api = app.getHttpServer();
    const auth = { [ADMIN_TOKEN_HEADER]: process.env.ADMIN_TOKEN! };
    await request(api).get('/knowledge/imports').expect(401);
    const list = await request(api).get('/knowledge/imports').set(auth).expect(200);
    expect(list.body.captures[0].organization.model).toBe('离线模型');
    expect(JSON.stringify(list.body)).not.toContain('endpointKey');
    const candidate = list.body.captures[0].candidates[0];
    const path = `/knowledge/imports/${f.id}/candidates/${candidate.id}`;
    await request(api)
      .put(path)
      .send({ content: candidate.content, expectedRevision: 0 })
      .expect(401);
    await request(api)
      .put(path)
      .set(auth)
      .send({
        content: {
          ...candidate.content,
          sources: candidate.content.sources.map((s: object) => ({ ...s, paragraphIds: ['P999'] })),
        },
        expectedRevision: 0,
      })
      .expect(400);
    await request(api)
      .put(path)
      .set(auth)
      .send({ content: { ...candidate.content, boardIds: ['不存在的板子'] }, expectedRevision: 0 })
      .expect(400);
    await request(api)
      .put(path)
      .set(auth)
      .send({ content: candidate.content, expectedRevision: 0 })
      .expect(200);
    await request(api)
      .put(path)
      .set(auth)
      .send({ content: candidate.content, expectedRevision: 0 })
      .expect(200);
    expect(await f.stores.knowledge.list()).toHaveLength(1);
    await request(api).get(`/knowledge/sources/${f.id}`).expect(200);
    expect(indexQueue.add).not.toHaveBeenCalled();
    await request(api)
      .post('/knowledge/imports')
      .set(auth)
      .send({ batchId: randomUUID(), urls: ['file:///private'] })
      .expect(400);
    await request(api)
      .post('/knowledge/imports')
      .set(auth)
      .send({ batchId: randomUUID(), urls: ['https://example.org/new'] })
      .expect(201);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(f.runtime.port.generate).toHaveBeenCalledTimes(1);
    const item = (await f.stores.knowledge.list())[0]!;
    await request(api)
      .put(`/knowledge/${item.id}/draft`)
      .set(auth)
      .send({
        revision: item.revision,
        content: {
          ...candidate.content,
          sources: candidate.content.sources.map((s: object) => ({
            ...s,
            url: 'https://example.org/forged',
          })),
        },
      })
      .expect(400);
    const result = await request(api)
      .post('/knowledge/imports/actions')
      .set(auth)
      .send({
        operation: 'activate',
        items: [
          { id: item.id, revision: item.revision, versionId: item.versions[0]!.versionId },
          { id: randomUUID(), revision: 0, versionId: randomUUID() },
        ],
      })
      .expect(201);
    expect(result.body.results).toHaveLength(2);
    expect(result.body.results.every((r: { error: string }) => r.error)).toBe(true);
  });

  it('批量索引拒绝核对后被修改的草稿，刷新修订号后索引实际内容', async () => {
    const f = await importFixture();
    await organizeKnowledgePage(f.stores, f.id, f.runtime);
    const candidate = (await f.stores.knowledgeImports.find(f.id))!.state.candidates[0]!;
    await f.stores.knowledgeImports.confirm(f.id, candidate.id, candidate.content, 0);
    const original = (await f.stores.knowledge.find(candidate.itemId))!;
    const updated = await f.stores.knowledge.saveDraft(original.id, original.revision, {
      ...candidate.content,
      body: '人工修改后的守护策略。',
    });
    const queue = { getJob: jest.fn(), add: jest.fn() };
    const runtime = vectorRuntime();
    jest.spyOn(embedding, 'embeddingRuntime').mockReturnValue(runtime);
    const controller = new KnowledgeImportController(f.stores, queue as never, queue as never);
    const item = {
      id: original.id,
      versionId: original.versions[0]!.versionId,
      revision: original.revision,
    };
    const rejected = await controller.actions({ operation: 'index', items: [item] });
    expect(rejected.results[0]!.error).toContain('知识已被修改');
    expect(queue.add).not.toHaveBeenCalled();
    expect((await f.stores.knowledge.version(item.versionId))!.state.status).toBe('draft');

    const accepted = await controller.actions({
      operation: 'index',
      items: [{ ...item, revision: updated.revision }],
    });
    expect(accepted.results[0]!.error).toBeNull();
    expect(queue.add).toHaveBeenCalledTimes(1);
    const indexed = (await f.stores.knowledge.version(item.versionId))!;
    expect(JSON.parse(indexed.state.task!.text)).toEqual(updated.versions[0]!.content);
    expect(runtime.port.generate).not.toHaveBeenCalled();
  });
});
