import { loadEnv } from '../config/env';
import { modelRuntimeOf } from '../llm/from-env';
import type { ModelAccess } from '../llm/model-port';
import type { RosterSeat } from '../store/games';
import { memoryAgents } from '../store/memory';
import { encryptAgentSecret } from './agent-secret';
import { seatContextOf } from './seat-context';

const SECRET_KEY = 'a1b2c3d4'.repeat(8);
const ENDPOINT = 'https://model.example.test/v1';
const OWN_ENDPOINT = 'https://other.example.test/v1';
const MODEL = '用例模型';
const OWN_MODEL = '自带型号';

/** 必填那几项照 .env.example 抄一份；能力按三个「端点 + 型号」都声明上，用例只动要验的那一项。 */
const BASE = {
  DATABASE_URL: 'postgresql://werewolf:werewolf@127.0.0.1:5432/werewolf',
  MODEL_API_KEY: 'sk-兜底',
  MODEL_BASE_URL: ENDPOINT,
  MODEL_DEFAULT_MODEL: MODEL,
  MODEL_CAPABILITIES: JSON.stringify([
    { baseUrl: ENDPOINT, model: MODEL, reasoningOff: null },
    { baseUrl: ENDPOINT, model: '另一型号', reasoningOff: null },
    { baseUrl: OWN_ENDPOINT, model: OWN_MODEL, reasoningOff: { thinking: { type: 'disabled' } } },
  ]),
  MODEL_REQUEST_TIMEOUT_MS: '120000',
  MODEL_MAX_ATTEMPTS: '3',
  AGENT_SECRET_KEY: SECRET_KEY,
};

const env = loadEnv(BASE);
/** 兜底那份就是环境变量那一套：没排阵容的局整局用它。 */
const FALLBACK = modelRuntimeOf(env).access;

/**
 * 排一队人出来：第一个自带端点与密钥，也带着人设与策略；第二个只挑了型号、没写过人设。
 * 走存储那一层，不绕接口——这一层要的是「已经排好的那几个人」。
 */
async function lineup() {
  const agents = memoryAgents();
  const withKey = await agents.create({
    name: '带钥匙的',
    modelName: OWN_MODEL,
    baseUrl: OWN_ENDPOINT,
    apiKeyCiphertext: encryptAgentSecret('sk-自带', SECRET_KEY),
    apiKeyHint: '自带',
    tag: null,
    notes: null,
  });
  const plain = await agents.create({
    name: '不带的',
    modelName: '另一型号',
    baseUrl: null,
    apiKeyCiphertext: null,
    apiKeyHint: null,
    tag: null,
    notes: null,
  });
  await agents.replaceMemories(withKey.id, {
    persona: [{ title: '说话短', body: '一句话不超过十个字' }],
    strategy: [
      { title: '先手', body: '首夜先刀边角' },
      { title: '后手', body: '留着票压到最后' },
    ],
  });

  const seats: RosterSeat[] = [
    {
      seatNo: 1,
      agentId: withKey.id,
      name: withKey.name,
      modelName: withKey.modelName,
      baseUrl: withKey.baseUrl,
    },
    {
      seatNo: 2,
      agentId: plain.id,
      name: plain.name,
      modelName: plain.modelName,
      baseUrl: plain.baseUrl,
    },
  ];

  return { agents, seats };
}

describe('逐座位的接入身份', () => {
  it('没排阵容的局整局共用兜底那份，摘要那一问也一样', async () => {
    const { agents } = await lineup();
    const { accessFor } = await seatContextOf({ env, roster: [], agents, fallback: FALLBACK });

    // 座位几号都行：命令行开的局正是这样，谁答都用环境变量那一套。
    expect(accessFor(1)).toBe(FALLBACK);
    expect(accessFor(12)).toBe(FALLBACK);
    expect(accessFor(null)).toBe(FALLBACK);
  });

  it('自带端点那一格：端点、型号、能力都按他那份，密钥解回明文', async () => {
    const { agents, seats } = await lineup();
    const { accessFor } = await seatContextOf({ env, roster: seats, agents, fallback: FALLBACK });

    expect(accessFor(1)).toEqual({
      baseUrl: OWN_ENDPOINT,
      model: OWN_MODEL,
      apiKey: 'sk-自带',
      capability: { reasoningOff: { thinking: { type: 'disabled' } } },
    } satisfies ModelAccess);
  });

  it('没自带端点那一格：端点与密钥走兜底，型号用他自己挑的那个', async () => {
    const { agents, seats } = await lineup();
    const { accessFor } = await seatContextOf({ env, roster: seats, agents, fallback: FALLBACK });

    expect(accessFor(2)).toEqual({
      baseUrl: ENDPOINT,
      model: '另一型号',
      apiKey: 'sk-兜底',
      capability: { reasoningOff: null },
    } satisfies ModelAccess);
  });

  it('折摘要那一问不是某个玩家在答，走兜底那份', async () => {
    const { agents, seats } = await lineup();
    const { accessFor } = await seatContextOf({ env, roster: seats, agents, fallback: FALLBACK });

    expect(accessFor(null)).toBe(FALLBACK);
  });

  it('排在这一格的人中途改过端点，这一局接不上', async () => {
    const { agents, seats } = await lineup();
    await agents.update(seats[0].agentId, { baseUrl: 'https://moved.example.test/v1' });

    // 拿新端点的密钥去问老端点，问回来的是个看不懂的 401；开局前就问清楚，别等烧了钱才发现。
    await expect(seatContextOf({ env, roster: seats, agents, fallback: FALLBACK })).rejects.toThrow(
      '改过接入端点',
    );
  });

  it('阵容里排的人不在了，当场抛', async () => {
    const { agents, seats } = await lineup();
    const gone: RosterSeat[] = [{ ...seats[0], agentId: '00000000-0000-0000-0000-000000000000' }];

    await expect(seatContextOf({ env, roster: gone, agents, fallback: FALLBACK })).rejects.toThrow(
      '不在了',
    );
  });

  it('问的座位不在阵容里，当场抛', async () => {
    const { agents, seats } = await lineup();
    const { accessFor, memoriesFor } = await seatContextOf({
      env,
      roster: seats,
      agents,
      fallback: FALLBACK,
    });

    expect(() => accessFor(4)).toThrow('阵容里没有 4 号这一格');
    expect(() => memoriesFor(4)).toThrow('阵容里没有 4 号这一格');
  });
});

describe('逐座位的人设与策略', () => {
  it('两类各摊成一段：标题当小标题、正文跟在后面', async () => {
    const { agents, seats } = await lineup();
    const { memoriesFor } = await seatContextOf({ env, roster: seats, agents, fallback: FALLBACK });

    expect(memoriesFor(1)).toEqual([
      '## 你的人设\n\n### 说话短\n一句话不超过十个字',
      '## 你的策略\n\n### 先手\n首夜先刀边角\n\n### 后手\n留着票压到最后',
    ]);
  });

  it('没写过人设的那一格是空数组，整段不占位', async () => {
    const { agents, seats } = await lineup();
    const { memoriesFor } = await seatContextOf({ env, roster: seats, agents, fallback: FALLBACK });

    expect(memoriesFor(2)).toEqual([]);
  });

  it('没排阵容的局没有人设可拼', async () => {
    const { agents } = await lineup();
    const { memoriesFor } = await seatContextOf({ env, roster: [], agents, fallback: FALLBACK });

    expect(memoriesFor(1)).toEqual([]);
  });

  it('只写了人设没写策略，就只有那一段', async () => {
    const { agents, seats } = await lineup();
    await agents.replaceMemories(seats[0].agentId, {
      persona: [{ title: '稳', body: '不抢话' }],
      strategy: [],
    });

    const { memoriesFor } = await seatContextOf({ env, roster: seats, agents, fallback: FALLBACK });

    expect(memoriesFor(1)).toEqual(['## 你的人设\n\n### 稳\n不抢话']);
  });
});
