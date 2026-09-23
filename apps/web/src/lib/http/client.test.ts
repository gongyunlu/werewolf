import { type AxiosAdapter, AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHttpClient } from './client';
import { ApiError } from './error';

const ok: AxiosAdapter = async (config) => ({
  data: { status: 'ok' },
  status: 200,
  statusText: 'OK',
  headers: new AxiosHeaders(),
  config,
});

describe('HTTP 请求', () => {
  it('返回通过契约校验的响应体', async () => {
    const client = createHttpClient({ adapter: ok });
    await expect(
      client.get('/health', { schema: z.object({ status: z.literal('ok') }) }),
    ).resolves.toEqual({ status: 'ok' });
    await expect(
      client.get('/health', { schema: z.object({ missing: z.string() }) }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('并发读取同一个地址互不取消', async () => {
    const controllers = [new AbortController(), new AbortController()];
    const releases: (() => void)[] = [];
    const client = createHttpClient({
      adapter: async (config) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return ok(config);
      },
    });
    const requests = controllers.map(({ signal }) => client.get('/games', { signal }));
    await Promise.resolve();
    expect(releases).toHaveLength(2);
    expect(controllers.every(({ signal }) => !signal.aborted)).toBe(true);
    releases.forEach((release) => release());
    await expect(Promise.all(requests)).resolves.toHaveLength(2);
  });

  it('遵守调用方的取消信号', async () => {
    const client = createHttpClient({ adapter: ok });
    await expect(client.get('/games', { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'CANCELED',
    });
  });

  it('传递服务端错误且不重复提交写请求', async () => {
    let calls = 0;
    const client = createHttpClient({
      adapter: async (config) => {
        calls += 1;
        throw new AxiosError('请求失败', 'ERR_BAD_RESPONSE', config, undefined, {
          data: { message: '服务不可用', code: 'SERVICE_UNAVAILABLE' },
          status: 503,
          statusText: 'ERR',
          headers: new AxiosHeaders(),
          config,
        });
      },
    });
    await expect(client.post('/games', {})).rejects.toMatchObject({
      status: 503,
      message: '服务不可用',
    });
    expect(calls).toBe(1);
  });
});
