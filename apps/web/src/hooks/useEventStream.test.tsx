import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEventStream } from './useEventStream';

const encoder = new TextEncoder();

function abortError() {
  return new DOMException('已中止', 'AbortError');
}

/** 伪造一个挂着等消息的事件流，只有被中止才断开 */
function stubStream(chunks: string[], status = 200) {
  const signals: AbortSignal[] = [];
  const closed = vi.fn();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options?: { signal?: AbortSignal }) => {
      const signal = options?.signal;
      let index = 0;

      if (signal) {
        signals.push(signal);
      }

      const reader = {
        read: async () => {
          if (signal?.aborted) {
            throw abortError();
          }

          if (index < chunks.length) {
            return { value: encoder.encode(chunks[index++]), done: false };
          }

          await new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              closed();
              reject(abortError());
            });
          });

          return { value: undefined, done: true };
        },
      };

      return {
        ok: status < 400,
        status,
        body: { getReader: () => reader },
      };
    }),
  );

  return { signals, closed };
}

describe('useEventStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('挂载后接收消息，并把连接状态置为已连接', async () => {
    stubStream(['data: {"n":1}\n\n']);

    const received: string[] = [];
    const { result } = renderHook(() =>
      useEventStream('/api/games/1/stream', (message) => received.push(message.data)),
    );

    await waitFor(() => expect(received).toEqual(['{"n":1}']));
    expect(result.current.connected).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('卸载时中止连接', async () => {
    const { signals } = stubStream(['data: 一条\n\n']);

    const { unmount } = renderHook(() => useEventStream('/api/games/1/stream', vi.fn()));

    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);

    unmount();

    expect(signals[0]?.aborted).toBe(true);
  });

  it('enabled 为 false 时不发起连接', async () => {
    stubStream([]);

    renderHook(() => useEventStream('/api/games/1/stream', vi.fn(), { enabled: false }));

    expect(fetch).not.toHaveBeenCalled();
  });

  it('url 为 null 时不发起连接', async () => {
    stubStream([]);

    renderHook(() => useEventStream(null, vi.fn()));

    expect(fetch).not.toHaveBeenCalled();
  });

  it('重渲染传入新的回调不会重连', async () => {
    stubStream(['data: 一条\n\n']);

    const { rerender } = renderHook(
      ({ handler }: { handler: (message: { data: string }) => void }) =>
        useEventStream('/api/games/1/stream', handler),
      { initialProps: { handler: vi.fn() } },
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    rerender({ handler: vi.fn() });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('连接失败时记录错误', async () => {
    stubStream([], 500);

    const { result } = renderHook(() =>
      useEventStream('/api/games/1/stream', vi.fn(), { enabled: true }),
    );

    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.connected).toBe(false);
  });
});
