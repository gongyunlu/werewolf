import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { testAppModule } from '../testing/app';
import { ADMIN_TOKEN_HEADER } from '../common/guards/admin-token.guard';
import { decryptAgentSecret } from './agent-secret';
import { memoryStores } from '../store/memory';
import type { GameStores } from '../store/stores';

/** 用例里的主密钥与管理令牌。构造时才读环境，这两行在各用例之前就位即可。 */
const SECRET_KEY = 'a1b2c3d4'.repeat(8);
/** 头里只能放 ASCII，中文令牌发不出去。 */
const TOKEN = 'test-admin-token';
process.env.AGENT_SECRET_KEY = SECRET_KEY;
process.env.ADMIN_TOKEN = TOKEN;

/** 一把假的密钥，形状像真的即可——这一层只验存与读，不拿它去调模型。 */
const API_KEY = 'sk-用例-0123456789abcdef';

function admin(token: string = TOKEN) {
  return { [ADMIN_TOKEN_HEADER]: token };
}

describe('agent 身份与接入接口', () => {
  let app: INestApplication;
  let stores: GameStores;

  beforeAll(async () => {
    stores = memoryStores();
    const moduleRef = await testAppModule(stores).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  /** 建一个。交回的是还没发出去的那个请求，调用处才接得上 expect。 */
  function create(body: Record<string, unknown>) {
    return request(app.getHttpServer()).post('/api/agents').set(admin()).send(body);
  }

  describe('建一个', () => {
    it('端点与自带密钥成对：只给密钥或只给端点都不收', async () => {
      const name = '半配';
      await create({ name, modelName: 'm', apiKey: API_KEY }).expect(400);
      await create({ name, modelName: 'm', baseUrl: 'https://a.example.test/v1' }).expect(400);

      // 两条都被拦下，库里不该留下这个人的痕迹。
      expect(await stores.agents.findByName(name)).toBeNull();
    });

    it('交出来的只有末四位，密钥本身一个字都不回', async () => {
      const { body } = await create({
        name: '带钥匙的',
        modelName: 'm-1',
        baseUrl: 'https://a.example.test/v1',
        apiKey: API_KEY,
        tag: 'ds',
      }).expect(201);

      expect(body.agent).toEqual({
        id: expect.any(String),
        name: '带钥匙的',
        modelName: 'm-1',
        baseUrl: 'https://a.example.test/v1',
        apiKeyHint: API_KEY.slice(-4),
        tag: 'ds',
        isActive: true,
        notes: null,
      });
      expect(JSON.stringify(body)).not.toContain(API_KEY);
    });

    it('落库的是密文，按主密钥解得回原样', async () => {
      const stored = await stores.agents.findByName('带钥匙的');
      expect(stored?.apiKeyCiphertext).not.toContain(API_KEY);
      expect(decryptAgentSecret(stored?.apiKeyCiphertext ?? '', SECRET_KEY)).toBe(API_KEY);
    });

    it('本机没配主密钥时不收自带密钥：报的是服务没配好，不是内部错误', async () => {
      process.env.AGENT_SECRET_KEY = '';

      try {
        const { body } = await create({
          name: '没主密钥',
          modelName: 'm',
          baseUrl: 'https://a.example.test/v1',
          apiKey: API_KEY,
        }).expect(503);

        expect(body.message).toContain('AGENT_SECRET_KEY');
      } finally {
        process.env.AGENT_SECRET_KEY = SECRET_KEY;
      }
    });

    it('重名当场报错，不靠库的唯一键报个内部错误', async () => {
      const { body } = await create({ name: '带钥匙的', modelName: 'm-2' }).expect(400);
      expect(body.message).toContain('带钥匙的');
    });
  });

  describe('列表', () => {
    it('默认只给启用的，要看全的得自己讲', async () => {
      const { body: created } = await create({ name: '停用的', modelName: 'm' }).expect(201);
      await request(app.getHttpServer())
        .patch(`/api/agents/${created.agent.id}`)
        .set(admin())
        .send({ isActive: false })
        .expect(200);

      const { body: live } = await request(app.getHttpServer()).get('/api/agents').expect(200);
      const { body: all } = await request(app.getHttpServer())
        .get('/api/agents?includeInactive=true')
        .expect(200);

      expect(live.agents.map((row: { name: string }) => row.name)).toEqual(['带钥匙的']);
      expect(all.agents.map((row: { name: string }) => row.name)).toEqual(['停用的', '带钥匙的']);
    });
  });

  describe('改一个', () => {
    let agentId: string;

    beforeAll(async () => {
      const { body } = await create({
        name: '要改的',
        modelName: 'm-1',
        baseUrl: 'https://a.example.test/v1',
        apiKey: API_KEY,
      }).expect(201);
      agentId = body.agent.id;
    });

    const patch = (body: Record<string, unknown>) =>
      request(app.getHttpServer()).patch(`/api/agents/${agentId}`).set(admin()).send(body);

    it('请求里没有密钥这一项，就保持原样', async () => {
      const { body } = await patch({ modelName: 'm-2' }).expect(200);

      expect(body.agent.modelName).toBe('m-2');
      expect(body.agent.apiKeyHint).toBe(API_KEY.slice(-4));
      expect(body.agent.baseUrl).toBe('https://a.example.test/v1');
    });

    it('给新密钥就换掉，给的还是明文', async () => {
      const next = 'sk-换过的-9876543210fedcba';
      const { body } = await patch({ apiKey: next }).expect(200);

      expect(body.agent.apiKeyHint).toBe(next.slice(-4));
      const stored = await stores.agents.find(agentId);
      expect(decryptAgentSecret(stored?.apiKeyCiphertext ?? '', SECRET_KEY)).toBe(next);
    });

    it('只清密钥不清端点，改完之后那份就不成对，当场拦下', async () => {
      await patch({ apiKey: null }).expect(400);
      // 拦下就得一点没动：密钥还在，端点是老的那个。
      const stored = await stores.agents.find(agentId);
      expect(stored?.apiKeyCiphertext).not.toBeNull();
      expect(stored?.baseUrl).toBe('https://a.example.test/v1');
    });

    it('端点与密钥一起清就放行，清完回落环境变量那一套', async () => {
      const { body } = await patch({ apiKey: null, baseUrl: null }).expect(200);

      expect(body.agent.baseUrl).toBeNull();
      expect(body.agent.apiKeyHint).toBeNull();
    });

    it('名字不在可改之列，请求里带了也不动它', async () => {
      const { body } = await patch({ name: '改过的名字' }).expect(200);

      expect(body.agent.name).toBe('要改的');
    });

    it('改一个不存在的，报的是没这个人', async () => {
      await request(app.getHttpServer())
        .patch('/api/agents/00000000-0000-0000-0000-000000000000')
        .set(admin())
        .send({ modelName: 'm' })
        .expect(404);
      await request(app.getHttpServer())
        .get('/api/agents/00000000-0000-0000-0000-000000000000')
        .expect(404);
    });
  });

  describe('人设与策略', () => {
    let agentId: string;

    beforeAll(async () => {
      const { body } = await create({ name: '有脾气的', modelName: 'm' }).expect(201);
      agentId = body.agent.id;
    });

    const put = (body: unknown) =>
      request(app.getHttpServer())
        .put(`/api/agents/${agentId}/memories`)
        .set(admin())
        .send(body as object);

    it('交上来的就是全集：上一批没交的等于删掉', async () => {
      await put({
        persona: [{ title: '说话短', body: '一句话不超过十个字' }],
        strategy: [{ title: '先手', body: '首夜先刀边角' }],
      }).expect(200);

      const { body } = await put({
        persona: [],
        strategy: [{ title: '后手', body: '留着票压到最后' }],
      }).expect(200);

      expect(body.memories).toEqual({
        persona: [],
        strategy: [{ title: '后手', body: '留着票压到最后' }],
      });
      const { body: read } = await request(app.getHttpServer())
        .get(`/api/agents/${agentId}/memories`)
        .expect(200);
      expect(read.memories).toEqual(body.memories);
    });

    it('合计超过二十条不收', async () => {
      const item = { title: 't', body: 'b' };
      const { body } = await put({
        persona: Array.from({ length: 21 }, () => item),
        strategy: [],
      }).expect(400);

      expect(body.message).toContain('20');
    });

    it('空标题不收', async () => {
      await put({ persona: [{ title: '', body: 'b' }], strategy: [] }).expect(400);
    });

    it('标题超过 64 个字在这一层就拦下，不留给数据库去报', async () => {
      const { body } = await put({
        persona: [{ title: '长'.repeat(65), body: 'b' }],
        strategy: [],
      }).expect(400);

      // 拦在契约里：漏到库那一层会是一个看不懂的 500，看不出是自己标题写长了。
      expect(body.message).toContain('标题最多 64 个字');
      expect((await stores.agents.memories(agentId)).persona).toEqual([]);
    });
  });

  describe('管理令牌', () => {
    it('写接口不带头一律拒', async () => {
      await request(app.getHttpServer())
        .post('/api/agents')
        .send({ name: 'x', modelName: 'm' })
        .expect(401);
    });

    it('带错令牌也拒', async () => {
      await request(app.getHttpServer())
        .post('/api/agents')
        .set(admin('another-token'))
        .send({ name: 'x', modelName: 'm' })
        .expect(401);
    });

    it('读接口不挂守卫，不带令牌照样给', async () => {
      await request(app.getHttpServer()).get('/api/agents').expect(200);
    });

    it('令牌长度对不上也拒，不比长度会直接抛', async () => {
      await request(app.getHttpServer())
        .post('/api/agents')
        .set(admin(TOKEN.slice(1)))
        .send({ name: 'x', modelName: 'm' })
        .expect(401);
    });

    it('本机没配令牌时写接口一律拒，不是放行', async () => {
      process.env.ADMIN_TOKEN = '';
      try {
        await request(app.getHttpServer())
          .post('/api/agents')
          .send({ name: 'x', modelName: 'm' })
          .expect(503);
      } finally {
        process.env.ADMIN_TOKEN = TOKEN;
      }
    });
  });
});
