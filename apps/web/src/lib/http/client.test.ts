import { type AxiosAdapter, AxiosError, AxiosHeaders, CanceledError } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './client';
import { ApiError } from './error';

type AdapterConfig = Parameters<AxiosAdapter>[0];

function ok(config: AdapterConfig, data: unknown) {
  return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders(), config };
}

/** 用自定义 adapter 顶掉真实网络，让拦截器、去重、重试都在测试里真实跑一遍 */
function adapterOf(handler: (config: AdapterConfig) => unknown): AxiosAdapter {
  return async (config) => {
    const result = handler(config);

    if (result instanceof Error) {
      throw result;
    }

    return ok(config, result);
  };
}

function networkError(config: AdapterConfig) {
  return new AxiosError('网络中断', 'ERR_NETWORK', config);
}

function statusError(config: AdapterConfig, status: number) {
  return new AxiosError('请求失败', 'ERR_BAD_RESPONSE', config, undefined, {
    data: { message: `服务端返回 ${status}`, code: `HTTP_${status}` },
    status,
    statusText: 'ERR',
    headers: new AxiosHeaders(),
    config,
  });
}

/** 挂着直到被取消的 adapter，用来观察去重与重试的相互影响 */
function hangingAdapter(onCall: (config: AdapterConfig) => void): AxiosAdapter {
  return async (config) => {
    onCall(config);
    const signal = config.signal as AbortSignal;

    // 真实 axios 遇到已中止的 signal 会在进入 adapter 前就抛 CanceledError
    if (signal.aborted) {
      throw new CanceledError(undefined, config);
    }

    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 50);

      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new CanceledError(undefined, config));
        },
        { once: true },
      );
    });

    return ok(config, 'ok');
  };
}

/** 记录每次请求，便于断言重试次数 */
function countingAdapter(handler: (config: AdapterConfig) => unknown) {
  const calls: string[] = [];

  const adapter = adapterOf((config) => {
    calls.push(`${config.method}:${config.url}`);
    return handler(config);
  });

  return { adapter, calls };
}

describe('HttpClient', () => {
  it('直接返回响应体，不要求调用方再取 .data', async () => {
    const client = new HttpClient({ adapter: adapterOf(() => ({ status: 'ok' })) });

    await expect(client.get('/health')).resolves.toEqual({ status: 'ok' });
  });

  it('把 axios 错误统一成 ApiError，并带上状态码与服务端消息', async () => {
    const client = new HttpClient({ adapter: adapterOf((config) => statusError(config, 400)) });

    const error: unknown = await client.get('/games').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, message: '服务端返回 400' });
  });

  it('同 url 再次发起时取消尚未完成的旧请求', async () => {
    const seen: AbortSignal[] = [];

    const client = new HttpClient({
      abortRepetitiveRequest: true,
      adapter: async (config) => {
        const signal = config.signal as AbortSignal;
        seen.push(signal);

        // adapter 自己负责响应中止，否则 axios 不会替我们打断这次请求
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 50);

          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new AxiosError('已取消', 'ERR_CANCELED', config));
            },
            { once: true },
          );
        });

        return ok(config, 'ok');
      },
    });

    const first = client.get('/games').catch((error: unknown) => error);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    const second = client.get('/games');
    await vi.waitFor(() => expect(seen).toHaveLength(2));

    expect(seen[0]?.aborted).toBe(true);
    expect(seen[1]?.aborted).toBe(false);

    await expect(second).resolves.toBe('ok');
    await expect(first).resolves.toBeInstanceOf(ApiError);
  });

  it('去重取消不算故障，不会触发重试', async () => {
    const calls: string[] = [];
    const client = new HttpClient({
      abortRepetitiveRequest: true,
      retry: { count: 2, baseDelay: 1 },
      adapter: hangingAdapter((config) => calls.push(`${config.method}:${config.url}`)),
    });

    const first = client.get('/health').catch((error: unknown) => error);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const second = client.get('/health');

    await expect(second).resolves.toBe('ok');
    await expect(first).resolves.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(2); // 被取消的那个不该再重发
  });

  it('退避期间后发的同键请求不会被旧请求的重试取消', async () => {
    const calls: string[] = [];
    let failedOnce = false;

    const hang = hangingAdapter((config) => calls.push(`${config.method}:${config.url}`));

    const client = new HttpClient({
      abortRepetitiveRequest: true,
      // 退避必须长于 vi.waitFor 默认的 50ms 轮询间隔，才能稳定卡在窗口内插入第二个请求
      retry: { count: 2, baseDelay: 200 },
      adapter: async (config) => {
        // 首次请求以网络故障告终，随后进入退避窗口
        if (!failedOnce) {
          failedOnce = true;
          calls.push(`${config.method}:${config.url}`);
          throw networkError(config);
        }

        return hang(config);
      },
    });

    const first = client.get('/health').catch((error: unknown) => error);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const second = client.get('/health');

    await expect(second).resolves.toBe('ok');
    await expect(first).resolves.toBeInstanceOf(ApiError);
  });

  it('未开启去重时两个同 url 请求都正常完成', async () => {
    const signals: (AbortSignal | undefined)[] = [];

    const client = new HttpClient({
      adapter: async (config) => {
        signals.push(config.signal as AbortSignal | undefined);
        return ok(config, 'ok');
      },
    });

    await Promise.all([client.get('/games'), client.get('/games')]);

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal?.aborted !== true)).toBe(true);
  });

  it('GET 遇到 5xx 会退避重试', async () => {
    const { adapter, calls } = countingAdapter((config) => statusError(config, 503));
    const client = new HttpClient({ adapter, retry: { count: 2, baseDelay: 1 } });

    await expect(client.get('/games')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(3); // 首次 + 2 次重试
  });

  it('POST 遇到 5xx 绝不重试，避免重复提交', async () => {
    const { adapter, calls } = countingAdapter((config) => statusError(config, 503));
    const client = new HttpClient({ adapter, retry: { count: 3, baseDelay: 1 } });

    await expect(client.post('/games/1/votes', { target: 3 })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it('GET 遇到 4xx 不重试', async () => {
    const { adapter, calls } = countingAdapter((config) => statusError(config, 404));
    const client = new HttpClient({ adapter, retry: { count: 3, baseDelay: 1 } });

    await expect(client.get('/games/404')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it('GET 网络层失败会重试', async () => {
    const { adapter, calls } = countingAdapter((config) => networkError(config));
    const client = new HttpClient({ adapter, retry: { count: 1, baseDelay: 1 } });

    await expect(client.get('/games')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(2);
  });
});
