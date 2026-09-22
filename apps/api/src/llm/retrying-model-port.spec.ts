import {
  ModelCallError,
  type ModelAccess,
  type ModelCallOptions,
  type ModelPort,
} from './model-port';
import { retryingModelPort, type RetryOptions } from './retrying-model-port';

const ACCESS: ModelAccess = {
  baseUrl: 'https://model.example.test/v1',
  model: '用例模型',
  apiKey: 'sk-用例',
  capability: { reasoningOff: null },
};

const REQUEST = { system: '你是谁', prompt: '要你做什么' };

/**
 * 按一段剧本作答的端口替身：每一项要么是一份正文，要么是一个要抛的错。
 * 答完剧本还往后问就是用例写错了，当场抛。
 */
function scriptedPort(script: readonly (string | Error)[]) {
  const asked: number[] = [];
  const port: ModelPort = {
    generate() {
      const step = script[asked.length];
      if (step === undefined) throw new Error(`剧本只准备了 ${script.length} 次回答`);
      asked.push(asked.length + 1);
      return step instanceof Error
        ? Promise.reject(step)
        : Promise.resolve({ content: step, toolCall: null, reasoning: null });
    },
  };
  return { port, asked };
}

/** 退避设成 0，用例跑起来不额外慢；要验冷却的那几条例另给 options。 */
function retrying(port: ModelPort, attempts = 3) {
  return retryingModelPort(port, { attempts, backoffMs: 0 });
}

/** 跑一次并把它抛出来的分类取回来。 */
async function failureOf(port: ModelPort, call?: ModelCallOptions) {
  return thrownBy(port.generate(REQUEST, ACCESS, call));
}

/** 等一次调用结束，把抛出来的分类取回来；没抛就是用例自己写错了。 */
async function thrownBy(pending: Promise<unknown>) {
  try {
    await pending;
  } catch (error) {
    return error as ModelCallError;
  }
  throw new Error('本该抛错');
}

/** 一次网络抖动。要的是分类，不是这一份具体的错。 */
const flaky = () => new ModelCallError('transient', '抖了一下');

/**
 * 从发出请求到第一次重试，隔了多少毫秒。
 * 一毫秒一毫秒地推假时钟，推到替身被问第二次为止；所以调用前得先开假时钟。
 */
async function retryAfterOf(failure: Error, options: RetryOptions): Promise<number> {
  const { port, asked } = scriptedPort([failure, '好']);
  const done = retryingModelPort(port, options).generate(REQUEST, ACCESS);

  let elapsed = 0;
  while (asked.length < 2) {
    await jest.advanceTimersByTimeAsync(1);
    elapsed += 1;
    if (elapsed > 1000) throw new Error('推了 1000ms 还没重发');
  }
  await done;
  return elapsed;
}

describe('模型端口重试', () => {
  it('第一次就成，只问一次', async () => {
    const { port, asked } = scriptedPort(['好']);

    await expect(retrying(port).generate(REQUEST, ACCESS)).resolves.toEqual({
      content: '好',
      toolCall: null,
      reasoning: null,
    });
    expect(asked).toHaveLength(1);
  });

  it('transient 再试，试到成', async () => {
    const { port, asked } = scriptedPort([new ModelCallError('transient', '网络抖了一下'), '好']);

    await expect(retrying(port).generate(REQUEST, ACCESS)).resolves.toEqual({
      content: '好',
      toolCall: null,
      reasoning: null,
    });
    expect(asked).toHaveLength(2);
  });

  it('试满次数还没成，抛 budget_exhausted 并把最后一次挂在 cause 上', async () => {
    const last = new ModelCallError('transient', '网络抖了一下');
    const { port, asked } = scriptedPort([new ModelCallError('transient', '断了一次'), last]);

    const error = await failureOf(retrying(port, 2));

    expect(asked).toHaveLength(2);
    expect(error.code).toBe('budget_exhausted');
    expect(error.message).toContain('试了 2 次都没成');
    expect(error.cause).toBe(last);
  });

  describe('重试间隔', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('退避带抖动，同一批请求不会等一样长再一起重发', async () => {
      const options = { attempts: 2, backoffMs: 20 };

      // 一轮投票是并行发出去的，撞限流的就是同一刻这批请求。
      // 抽到 0 等一半、抽到 1 等满：两种时长错开，才不会一起把限流原样撞第二遍。
      expect(await retryAfterOf(flaky(), { ...options, random: () => 0 })).toBe(10);
      expect(await retryAfterOf(flaky(), { ...options, random: () => 1 })).toBe(20);
    });

    it('端点说了等多久就听它的，不按退避算', async () => {
      const failure = new ModelCallError('transient', '被限流了', { retryAfterMs: 40 });

      // 退避只算到 20ms，端点要的冷却窗口是 40ms：按退避走就是提前重发，白撞一次。
      expect(await retryAfterOf(failure, { attempts: 2, backoffMs: 20, random: () => 1 })).toBe(40);
    });

    it('端点要的比退避还短，就还按退避等', async () => {
      const failure = new ModelCallError('transient', '被限流了', { retryAfterMs: 5 });

      expect(await retryAfterOf(failure, { attempts: 2, backoffMs: 20, random: () => 1 })).toBe(20);
    });

    it('退避关掉时，端点点名要的冷却照样得等', async () => {
      const failure = new ModelCallError('transient', '被限流了', { retryAfterMs: 40 });

      // 那个开关关的是退避，不是端点要的冷却窗口；跟着一起关掉，三次机会会在几毫秒里打光。
      expect(await retryAfterOf(failure, { attempts: 2, backoffMs: 0 })).toBe(40);
    });
  });

  describe('中止', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('调用方已经喊停，一次都不再试', async () => {
      const { port, asked } = scriptedPort([flaky(), '好']);

      const error = await failureOf(retryingModelPort(port, { backoffMs: 20 }), {
        signal: AbortSignal.abort(),
      });

      // 重发的前提是调用方还要这份答复；喊停了还去试，既白等又白花一次调用。
      expect(asked).toHaveLength(1);
      expect(error.code).toBe('deadline');
    });

    it('退避等到一半被喊停，剩下的时间不再等', async () => {
      const stopping = new AbortController();
      const { port, asked } = scriptedPort([flaky(), '好']);
      const pending = retryingModelPort(port, { backoffMs: 1000 }).generate(REQUEST, ACCESS, {
        signal: stopping.signal,
      });

      // 先推到第一次重试排上队，再喊停：不认中止的话这一条要等满 500 毫秒往上。
      await jest.advanceTimersByTimeAsync(1);
      stopping.abort();

      expect(asked).toHaveLength(1);
      expect((await thrownBy(pending)).code).toBe('deadline');
    });
  });

  // invalid_output 也在这张表里：这一层在解析之下，它本来就走不到这儿，重问归上面那一层（graph.ts）。
  it.each<[string]>([['invalid_output'], ['fatal'], ['deadline'], ['circuit_open']])(
    '%s 不重试，当场抛',
    async (code) => {
      const cause = new ModelCallError(code as ModelCallError['code'], '不值得再试');
      const { port, asked } = scriptedPort([cause, '好']);

      const error = await failureOf(retrying(port));

      expect(asked).toHaveLength(1);
      expect(error).toBe(cause);
    },
  );

  it('已经吐过字的流不重试，当场抛', async () => {
    const cause = new ModelCallError('transient', '吐到一半断了', { partialOutput: true });
    const { port, asked } = scriptedPort([cause, '好']);

    const error = await failureOf(retrying(port));

    // 这半截话调用方已经拿到手了，重发就是把两段话接在一起。
    expect(asked).toHaveLength(1);
    expect(error).toBe(cause);
  });

  it('流式回调原样转给下层', async () => {
    const seen: string[] = [];
    const port: ModelPort = {
      generate(_request, _access, call) {
        call?.onDelta?.('我坐');
        return Promise.resolve({ content: '我坐', toolCall: null, reasoning: null });
      },
    };

    const answer = await retrying(port).generate(REQUEST, ACCESS, {
      onDelta: (delta) => seen.push(delta),
    });

    expect(seen).toEqual(['我坐']);
    expect(answer).toEqual({ content: '我坐', toolCall: null, reasoning: null });
  });

  it('不是模型调用失败的错原样往上抛', async () => {
    const cause = new TypeError('代码自己写错了');
    const { port, asked } = scriptedPort([cause]);

    const error = await failureOf(retrying(port));

    expect(asked).toHaveLength(1);
    expect(error).toBe(cause);
  });

  it('重试时把同一次请求原样重发', async () => {
    const seen: unknown[] = [];
    const port: ModelPort = {
      generate(request, access) {
        seen.push({ request, access });
        return seen.length === 1
          ? Promise.reject(new ModelCallError('transient', '抖了一下'))
          : Promise.resolve({ content: '好', toolCall: null, reasoning: null });
      },
    };

    await retrying(port).generate(REQUEST, ACCESS);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
  });
});
