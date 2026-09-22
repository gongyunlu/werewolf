import { loadEnv } from '../config/env';
import { modelRuntimeOf, promptSourceOf } from './from-env';

const ENDPOINT = 'https://model.example.test/v1';
const MODEL = '用例模型';

/** 一条对得上的能力声明，只改要验的那一项。 */
function capabilityOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseUrl: ENDPOINT,
    model: MODEL,
    allowCodeFence: false,
    reasoningOff: null,
    ...overrides,
  };
}

/** 必填那几项照 .env.example 抄一份，拼出来的等价于一份照着模板填的 .env。 */
const BASE = {
  DATABASE_URL: 'postgresql://werewolf:werewolf@127.0.0.1:5434/werewolf',
  MODEL_BASE_URL: ENDPOINT,
  MODEL_DEFAULT_MODEL: MODEL,
  MODEL_CAPABILITIES: JSON.stringify([
    capabilityOf({ reasoningOff: { thinking: { type: 'disabled' } } }),
  ]),
  MODEL_REQUEST_TIMEOUT_MS: '120000',
  MODEL_MAX_ATTEMPTS: '3',
};

/** 在这份底子上改几项，当一份 .env 用。 */
function envOf(overrides: Record<string, string> = {}) {
  return loadEnv({ ...BASE, ...overrides });
}

/** 不带任何密钥，等价于一份没写密钥的 .env。 */
const BARE = envOf();

describe('环境变量契约', () => {
  it('必填项少一个就当场抛，不拿一份猜的配置开局', () => {
    const { MODEL_DEFAULT_MODEL: _omitted, ...incomplete } = BASE;

    expect(() => loadEnv(incomplete)).toThrow('环境变量校验失败');
  });

  it('端点不是个地址，也拦在这一层', () => {
    // 不拦的话，第一处报错是取能力时 new URL 抛的裸 TypeError，看不出是哪一项写错了。
    expect(() => envOf({ MODEL_BASE_URL: '不是地址' })).toThrow('环境变量校验失败');
  });
});

describe('按环境变量接线', () => {
  describe('提示词源', () => {
    it('凭据空着也给一份源，取的时候才报没配', async () => {
      const source = promptSourceOf(BARE);

      await expect(source.load('发牌')).rejects.toThrow('没配 LANGFUSE_PUBLIC_KEY');
    });

    it('只配了一个 key 也按没配处理，不去拿半个身份试', async () => {
      const source = promptSourceOf(envOf({ LANGFUSE_PUBLIC_KEY: 'pk-用例' }));

      await expect(source.load('发牌')).rejects.toThrow('没配 LANGFUSE_PUBLIC_KEY');
    });
  });

  describe('模型接入', () => {
    it('没有密钥当场抛，不让一局跑到第一次开口才发现', () => {
      expect(() => modelRuntimeOf(BARE)).toThrow('没配 MODEL_API_KEY');
    });

    it('密钥配上就能拼出端口与接入身份', () => {
      const env = envOf({ MODEL_API_KEY: 'sk-test' });

      const runtime = modelRuntimeOf(env);

      expect(runtime.port.generate).toBeInstanceOf(Function);
      expect(runtime.access).toEqual({
        baseUrl: ENDPOINT,
        model: MODEL,
        apiKey: 'sk-test',
        capability: { allowCodeFence: false, reasoningOff: { thinking: { type: 'disabled' } } },
      });
    });

    it('端点、型号与两个数都从环境变量读出来', () => {
      const other = capabilityOf({ baseUrl: `${ENDPOINT}/`, model: '另一个型号' });
      const env = envOf({
        MODEL_API_KEY: 'sk-test',
        MODEL_BASE_URL: `${ENDPOINT}/`,
        MODEL_DEFAULT_MODEL: '另一个型号',
        MODEL_CAPABILITIES: JSON.stringify([capabilityOf(), other]),
        MODEL_REQUEST_TIMEOUT_MS: '3000',
        MODEL_MAX_ATTEMPTS: '5',
      });

      // 这两个是从字符串读出来的，读成 NaN 或者停在默认值都不会当场报错。
      expect(env.MODEL_REQUEST_TIMEOUT_MS).toBe(3000);
      expect(env.MODEL_MAX_ATTEMPTS).toBe(5);

      const runtime = modelRuntimeOf(env);

      // 末尾那个斜杠由端口和取能力那两处各自归掉，接入身份里留原样。
      expect(runtime.access.baseUrl).toBe(`${ENDPOINT}/`);
      expect(runtime.access.model).toBe('另一个型号');
      expect(runtime.access.capability).toEqual({ allowCodeFence: false, reasoningOff: null });
    });

    it('超时与次数真的接到了端口上', async () => {
      const env = envOf({
        MODEL_API_KEY: 'sk-test',
        MODEL_REQUEST_TIMEOUT_MS: '20',
        MODEL_MAX_ATTEMPTS: '2',
      });
      const sent: RequestInit[] = [];
      const real = globalThis.fetch;
      // 一直不回，只能靠端口自己那个超时中止；次数对不对看发了几回。
      // 端口是在拼出来那一刻取走 fetch 的，所以替换要排在 modelRuntimeOf 前面。
      globalThis.fetch = ((_url: string, init: RequestInit) => {
        sent.push(init);
        return new Promise<Response>((_done, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }) as typeof fetch;

      try {
        const runtime = modelRuntimeOf(env);

        await expect(
          runtime.port.generate({ system: '你是谁', prompt: '要你做什么' }, runtime.access),
        ).rejects.toThrow('试了 2 次');
      } finally {
        globalThis.fetch = real;
      }

      expect(sent).toHaveLength(2);
    });

    it('端点和型号都对不上任何声明时当场抛', () => {
      const env = envOf({ MODEL_API_KEY: 'sk-test', MODEL_DEFAULT_MODEL: '没见过的型号' });

      expect(() => modelRuntimeOf(env)).toThrow('未声明该端点与模型的能力');
    });
  });
});
