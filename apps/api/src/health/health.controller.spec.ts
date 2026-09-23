import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { testAppModule } from '../testing/app';
import { memoryStores } from '../store/memory';

describe('HealthController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await testAppModule(memoryStores()).compile();

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
