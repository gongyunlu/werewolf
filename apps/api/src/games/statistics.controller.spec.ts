import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ACTION_TYPES } from '@werewolf/shared';
import { memoryStores } from '../store/memory';
import { GAME_STORES } from '../store/stores.provider';
import { StatisticsController } from './statistics.controller';

describe('只读开销查询', () => {
  let app: INestApplication;
  let stores: ReturnType<typeof memoryStores>;

  beforeEach(async () => {
    stores = memoryStores();
    await stores.games.open({ gameId: 'g', boardId: 'test', roster: [] });
    await stores.actions.begin({
      gameId: 'g',
      actionKey: 'a',
      phaseInstanceId: 'vote/1',
      actorId: 'p1',
      actionType: ACTION_TYPES.VOTE,
      actionOrdinal: 0,
      ledgerSeq: 0,
    });
    for (const [actionKey, summaryKey, total] of [
      ['a', undefined, 4],
      [null, 'summary:1:public', 8],
    ] as const) {
      const callId = randomUUID();
      const recording = await stores.asked.append('g', {
        actionKey,
        summaryKey,
        model: 'test',
        prompt: 'private-prompt',
        system: 'private-system',
        observation: {
          callId,
          executionId: randomUUID(),
          step: summaryKey ? 'summary' : 'generate',
          formatAttempt: 1,
          endpointKey: 'hashed-endpoint',
        },
      });
      await recording!.startAttempt(1);
      await recording!.finishAttempt(1, {
        status: 'succeeded',
        failureCode: null,
        dispatched: true,
        durationMs: 10,
        httpStatus: 200,
        requestId: null,
        usage: { total_tokens: total, completion_tokens: 0 },
        usageComplete: true,
        thinkingMs: null,
      });
      await recording!.finish({ status: 'accepted', failureCode: null, durationMs: 20 });
      if (actionKey) await stores.actions.finish(actionKey, { snapshot: { sourceCallId: callId } });
    }
    const module = await Test.createTestingModule({
      controllers: [StatisticsController],
      providers: [{ provide: GAME_STORES, useValue: stores }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });

  it('公共摘要不分摊给玩家；翻页只影响明细，汇总与采用来源稳定', async () => {
    const first = await request(app.getHttpServer())
      .get('/api/games/g/statistics?limit=1')
      .expect(200);
    expect(first.body.total.tokens.total.knownSum).toBe(12);
    expect(first.body.publicOverhead.tokens.total.knownSum).toBe(8);
    expect(first.body.players[0].tokens.total.knownSum).toBe(4);
    expect(first.body.calls).toHaveLength(1);
    expect(first.body.calls[0].adopted).toBe(true);
    const second = await request(app.getHttpServer())
      .get(`/api/games/g/statistics?after=${first.body.nextCursor}&limit=1`)
      .expect(200);
    expect(second.body.total).toEqual(first.body.total);
    expect(second.body.calls[0].summaryKey).toBe('summary:1:public');
    expect(second.body.calls[0].adopted).toBeNull();
    expect(second.body.nextCursor).toBeNull();
    expect(JSON.stringify(first.body)).not.toMatch(/private-prompt|private-system|apiKey|baseUrl/);
    expect(first.body.total.tokens.input.knownSum).toBeNull();
    expect(first.body.total.tokens.output.knownSum).toBe(0);
  });

  it('旧行无请求推算、无假零、无来源猜测；混合局显示覆盖不完整', async () => {
    await stores.asked.append('g', { actionKey: null, model: 'old', prompt: 'old', system: 'old' });
    const result = await request(app.getHttpServer()).get('/api/games/g/statistics').expect(200);
    expect(result.body.total).toMatchObject({
      coverage: 'partial',
      logicalCalls: 2,
      legacyPrompts: 1,
    });
    expect(result.body.calls[2]).toMatchObject({ callId: null, adopted: null, attempts: [] });
    expect(result.body.unattributed).toMatchObject({
      coverage: 'legacy',
      tokens: { total: { knownSum: null } },
    });
  });

  it('没有任何题面的旧空局不能宣称观测完整或零用量', async () => {
    await stores.games.open({ gameId: 'empty', boardId: 'test', roster: [] });
    const result = await request(app.getHttpServer())
      .get('/api/games/empty/statistics')
      .expect(200);
    expect(result.body.total.coverage).toBe('unknown');
    expect(result.body.total.tokens.total.knownSum).toBeNull();
    expect(result.body.total.averageRequestDurationMs).toBeNull();
  });

  it('校验筛选归属、互斥、游标和页长，不接受写入请求', async () => {
    await request(app.getHttpServer()).get('/api/games/g/statistics?actionKey=a').expect(200);
    for (const query of [
      'actionKey=a&summaryKey=s',
      'after=999',
      'limit=201',
      'limit=0',
      'limit=1.5',
      'unexpected=1',
    ]) {
      await request(app.getHttpServer()).get(`/api/games/g/statistics?${query}`).expect(400);
    }
    await request(app.getHttpServer())
      .get('/api/games/g/statistics?actionKey=elsewhere')
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/games/g/statistics?summaryKey=elsewhere')
      .expect(404);
    await request(app.getHttpServer()).get('/api/games/elsewhere/statistics').expect(404);
    await request(app.getHttpServer()).post('/api/games/g/statistics').expect(404);
  });
});
