import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { memoryStores } from '../store/memory';
import { GAME_STORES } from '../store/stores.provider';

describe('HealthController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // 应用装配带上了存储，真连库得有库在；这一条只验装配，给它一份内存的。
      .overrideProvider(GAME_STORES)
      .useValue(memoryStores())
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('应用装配完成后健康检查返回 ok', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200).expect({ status: 'ok' });
  });
});
