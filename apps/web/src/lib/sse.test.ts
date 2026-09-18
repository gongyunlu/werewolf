import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStreamError, openEventStream } from './sse';

const encoder = new TextEncoder();

function abortError() {
  return new DOMException('已中止', 'AbortError');
}

interface StreamBehaviour {
  /** 本次连接要吐出的分片 */
  chunks?: string[];
  /** 非 2xx 时返回的状态码 */
  status?: number;
  /** 吐完分片后立刻正常结束，而不是挂着等新消息 */
  endAfterChunks?: boolean;
}

/**
 * 伪造事件流：每次 fetch 取一份 behaviour，记录收到的请求头，
 * 分片吐完后默认挂起等新消息（真实事件流不会自己结束），只有被中止才断开。
 */
function stubStreams(behaviours: StreamBehaviour[]) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  let call = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string, options?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
        const signal = options?.signal;
        const behaviour = behaviours[Math.min(call, behaviours.length - 1)]!;
        call += 1;
        requests.push({ url, headers: options?.headers ?? {} });

        const chunks = behaviour.chunks ?? [];
        let index = 0;

        const reader = {
          read: async () => {
            if (signal?.aborted) {
              throw abortError();
            }

            if (index < chunks.length) {
              return { value: encoder.encode(chunks[index++]), done: false };
            }

            if (behaviour.endAfterChunks) {
              return { value: undefined, done: true };
            }

            await new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(abortError()));
            });

            return { value: undefined, done: true };
          },
        };

        return {
          ok: behaviour.status === undefined || behaviour.status < 400,
          status: behaviour.status ?? 200,
          body: { getReader: () => reader },
        };
      },
    ),
  );

  return { requests, callCount: () => call };
}

describe('openEventStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('按帧解析事件，跨分片且切在汉字中间的消息也能拼回', async () => {
    stubStreams([{ chunks: ['data: {"n":1}\n\n', 'data: {"n":', '"狼人"}\n\n'] }]);

    const received: string[] = [];
    const handle = openEventStream('/api/games/1/stream', {
      handlers: { onMessage: (message) => received.push(message.data) },
    });

    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toEqual(['{"n":1}', '{"n":"狼人"}']);

    handle.close();
    await handle.closed;
  });

  it('解析 event 与 id 字段', async () => {
    stubStreams([{ chunks: ['event: speech\nid: 42\ndata: 天黑请闭眼\n\n'] }]);

    const events: string[] = [];
    const handle = openEventStream('/api/games/1/stream', {
      handlers: {
        onMessage: (message) => events.push(`${message.event}/${message.id}/${message.data}`),
      },
    });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events).toEqual(['speech/42/天黑请闭眼']);

    handle.close();
    await handle.closed;
  });

  it('服务端关闭后重连，并带上 Last-Event-ID 续传', async () => {
    stubStreams([
      { chunks: ['id: 7\ndata: 第一条\n\n'], endAfterChunks: true },
      { chunks: ['id: 8\ndata: 第二条\n\n'] },
    ]);

    const received: string[] = [];
    const onOpen = vi.fn();
    const handle = openEventStream('/api/games/1/stream', {
      retryDelays: [1],
      handlers: { onMessage: (message) => received.push(message.data), onOpen },
    });

    await vi.waitFor(() => expect(received).toHaveLength(2));

    expect(onOpen).toHaveBeenNthCalledWith(1, false);
    expect(onOpen).toHaveBeenNthCalledWith(2, true);

    handle.close();
    await handle.closed;
  });

  it('重连成功后再次断开，请求会带上上一次的事件 id', async () => {
    const { requests } = stubStreams([
      { chunks: ['id: 7\ndata: 第一条\n\n'], endAfterChunks: true },
      { chunks: ['id: 8\ndata: 第二条\n\n'], endAfterChunks: true },
      { chunks: ['id: 9\ndata: 第三条\n\n'] },
    ]);

    const received: string[] = [];
    const handle = openEventStream('/api/games/1/stream', {
      retryDelays: [1, 1],
      handlers: { onMessage: (message) => received.push(message.data) },
    });

    await vi.waitFor(() => expect(received).toHaveLength(3));

    expect(requests[0]?.headers['Last-Event-ID']).toBeUndefined();
    expect(requests[1]?.headers['Last-Event-ID']).toBe('7');
    expect(requests[2]?.headers['Last-Event-ID']).toBe('8');

    handle.close();
    await handle.closed;
  });

  it('4xx 不重试，报错后立即结束', async () => {
    const { callCount } = stubStreams([{ status: 403 }]);

    const errors: unknown[] = [];
    const handle = openEventStream('/api/games/1/stream', {
      retryDelays: [1, 1, 1],
      handlers: { onMessage: vi.fn(), onError: (error) => errors.push(error) },
    });

    await handle.closed;

    expect(callCount()).toBe(1);
    expect(errors[0]).toBeInstanceOf(EventStreamError);
    expect((errors[0] as EventStreamError).retryable).toBe(false);
  });

  it('5xx 按退避序列重试，用尽后结束', async () => {
    const { callCount } = stubStreams([{ status: 503 }]);

    const errors: unknown[] = [];
    const handle = openEventStream('/api/games/1/stream', {
      retryDelays: [1, 1],
      handlers: { onMessage: vi.fn(), onError: (error) => errors.push(error) },
    });

    await handle.closed;

    expect(callCount()).toBe(3); // 首次 + 2 次重试
    expect(errors).toHaveLength(3);
  });

  it('服务端收下连接后立刻正常关流时，退避用尽即停止重连', async () => {
    const { callCount } = stubStreams([{ endAfterChunks: true }]);

    const handle = openEventStream('/api/games/1/stream', {
      retryDelays: [1, 1],
      handlers: { onMessage: vi.fn() },
    });

    await handle.closed;

    expect(callCount()).toBe(3); // 首次 + 2 次重试，而不是每秒一次无限重连
  });

  it('退避等待正常到期时摘掉 abort 监听器，不随重连次数堆积', async () => {
    const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');

    const { callCount } = stubStreams([{ endAfterChunks: true }]);
    const handle = openEventStream('/api/games/1/stream', {
      retryDelays: [1, 1],
      handlers: { onMessage: vi.fn() },
    });

    await handle.closed;

    const abortAdds = addSpy.mock.calls.filter(([type]) => type === 'abort');
    const abortRemoves = removeSpy.mock.calls.filter(([type]) => type === 'abort');

    expect(callCount()).toBe(3);
    expect(abortAdds).toHaveLength(2); // 两次退避各挂一个
    expect(abortRemoves.map(([, listener]) => listener)).toEqual(
      abortAdds.map(([, listener]) => listener),
    );

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('retryDelays 为空表示断开即结束', async () => {
    const { callCount } = stubStreams([{ status: 500 }]);

    const handle = openEventStream('/api/games/1/stream', {
      retryDelays: [],
      handlers: { onMessage: vi.fn() },
    });

    await handle.closed;

    expect(callCount()).toBe(1);
  });

  it('主动 close() 后不再重连，也不回调 onError', async () => {
    const { callCount } = stubStreams([{ chunks: ['data: 一条\n\n'] }]);

    const onError = vi.fn();
    const handle = openEventStream('/api/games/1/stream', {
      retryDelays: [1, 1],
      handlers: { onMessage: vi.fn(), onError },
    });

    handle.close();
    await handle.closed;

    expect(callCount()).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
