import { ModelCallError, type ModelAccess, type ModelPort, type ModelRequest } from './model-port';

export interface RetryOptions {
  /** 一共试几次，含第一次。 */
  attempts?: number;
  /** 第一次重试前等多少毫秒，往后按第几次成倍加。 */
  backoffMs?: number;
  /** 抖动用的随机源，取值 [0, 1)。用例里换成定值，好断言等多久。 */
  random?: () => number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 500;

/**
 * 第几次重试等多久：按次数成倍加，再在一半到全额之间随机取。
 *
 * 随机是必须的，不是锦上添花：一轮投票、狼队商议都是并行问一整批人，
 * 撞上限流的是同一刻发出去的一批请求。退避要是定值，这批人会等一样长再一起重发，
 * 把限流原样撞第二遍。留一半的下限是免得抽到接近零的那次变成「立刻重发」，那等于没退避。
 */
function backoffOf(attempt: number, backoffMs: number, random: () => number): number {
  const full = backoffMs * attempt;
  return full / 2 + random() * (full / 2);
}

/**
 * 等一会儿再重发。
 * 判据是这次实际要等多久，不是退避开没开：端点点名要的冷却也算实际要等多久，
 * 不该跟着退避一起被关掉。算出来是 0 就当场过去，用例靠这个把等待关掉。
 */
function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve();
}

/**
 * 给底层端口加一层重试。
 * 只重试 transient：fatal 是端点明确的拒绝，试几次都一样；其余几类码留给定时的调用方去发，这儿不认。
 * invalid_output 也归调用方：这一层在解析之下，模型答得合不合规它根本看不见（那一层见 turn/graph.ts）。
 *
 * 已经在吐字的流是个例外：那半截话调用方已经拿到手了，重发就是把两段话接在一起，
 * 前端看到的是句胡话，所以标了 partialOutput 的当场抛。
 */
export function retryingModelPort(port: ModelPort, options: RetryOptions = {}): ModelPort {
  const {
    attempts = DEFAULT_ATTEMPTS,
    backoffMs = DEFAULT_BACKOFF_MS,
    random = Math.random,
  } = options;
  return {
    async generate(request: ModelRequest, access: ModelAccess, onDelta?: (delta: string) => void) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await port.generate(request, access, onDelta);
        } catch (error) {
          // 不是模型调用失败的一律原样往上抛：这一层只懂模型调用的分类，别的错不替它兜。
          if (!(error instanceof ModelCallError) || error.code !== 'transient') throw error;
          // 已经吐出去的字收不回来，重发只会把两段话接在一起。
          if (error.partialOutput) throw error;
          if (attempt >= attempts) {
            throw new ModelCallError(
              'budget_exhausted',
              `试了 ${attempts} 次都没成：${error.message}`,
              {
                cause: error,
              },
            );
          }
          // 端点说了等多久就听它的：退避算出来的时长可能远短于它要的冷却窗口，
          // 那样三次机会会在几秒内打光、报一句「都没成」，真正该等的时间一秒没等。
          const backoff = backoffOf(attempt, backoffMs, random);
          await wait(Math.max(backoff, error.retryAfterMs ?? 0));
        }
      }
    },
  };
}
