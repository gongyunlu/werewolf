import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventStream } from './useEventStream';

/** 只模拟浏览器事件，保留连接地址和关闭次数供断线用例核对。 */
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  close = vi.fn();

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
}

describe('useEventStream', () => {
  it('断线后关闭原生重连，按指数退避重试，连续五次失败后停止', async () => {
    vi.useFakeTimers();
    const view = renderHook(() => useEventStream('/events', vi.fn()));
    try {
      for (const delay of [1000, 2000, 4000, 8000]) {
        const source = FakeEventSource.instances.at(-1)!;
        const count = FakeEventSource.instances.length;
        act(() => source.dispatchEvent(new Event('open')));
        act(() => source.dispatchEvent(new Event('error')));
        expect(source.close).toHaveBeenCalledOnce();
        await act(() => vi.advanceTimersByTimeAsync(delay - 1));
        expect(FakeEventSource.instances).toHaveLength(count);
        await act(() => vi.advanceTimersByTimeAsync(1));
        expect(FakeEventSource.instances).toHaveLength(count + 1);
      }
      act(() => FakeEventSource.instances.at(-1)!.dispatchEvent(new Event('error')));
      await act(() => vi.advanceTimersByTimeAsync(600000));
      expect(FakeEventSource.instances).toHaveLength(5);
      expect(view.result.current.connected).toBe(false);
      act(() => view.result.current.retry());
      expect(FakeEventSource.instances).toHaveLength(6);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('接收事实和预览，重连携带最后的事件序号并清除错误', async () => {
    const received = vi.fn();
    const { result } = renderHook(() => useEventStream('/api/games/1/events', received));
    const source = FakeEventSource.instances[0];
    act(() => source.dispatchEvent(new Event('open')));
    expect(result.current.connected).toBe(true);

    act(() => {
      source.dispatchEvent(new MessageEvent('message', { data: '事实', lastEventId: '7' }));
      source.dispatchEvent(new MessageEvent('preview', { data: '预览' }));
    });
    expect(received.mock.calls.map(([event]) => [event.type, event.data])).toEqual([
      ['message', '事实'],
      ['preview', '预览'],
    ]);
    act(() => source.dispatchEvent(new Event('error')));
    expect(result.current.connected).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    const resumed = FakeEventSource.instances[1];
    expect(new URL(resumed.url).searchParams.get('after')).toBe('7');
    act(() => resumed.dispatchEvent(new Event('open')));
    expect(result.current.connected).toBe(true);
    expect(result.current.error).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('回调更新不重连，后续消息发给新的回调', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ handler }) => useEventStream('/events', handler), {
      initialProps: { handler: first },
    });
    rerender({ handler: second });
    act(() =>
      FakeEventSource.instances[0].dispatchEvent(new MessageEvent('message', { data: '新消息' })),
    );
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('切换地址、禁用和卸载时关闭旧连接', () => {
    const { rerender, unmount, result } = renderHook(
      ({ url, enabled }) => useEventStream(url, vi.fn(), { enabled }),
      { initialProps: { url: '/one', enabled: true } },
    );
    const first = FakeEventSource.instances[0];
    act(() => first.dispatchEvent(new Event('open')));
    rerender({ url: '/two', enabled: true });
    expect(first.close).toHaveBeenCalledOnce();
    expect(result.current.connected).toBe(false);
    const second = FakeEventSource.instances[1];
    rerender({ url: '/two', enabled: false });
    expect(second.close).toHaveBeenCalledOnce();
    rerender({ url: '/two', enabled: true });
    const third = FakeEventSource.instances[2];
    unmount();
    expect(third.close).toHaveBeenCalledOnce();
  });

  it('没有地址或已禁用时不创建连接', () => {
    renderHook(() => useEventStream(null, vi.fn()));
    renderHook(() => useEventStream('/events', vi.fn(), { enabled: false }));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it.each(['禁用', '卸载'])('退避期间%s会取消重连，旧连接的迟到事件无效', async (action) => {
    const received = vi.fn();
    const view = renderHook(({ enabled }) => useEventStream('/events', received, { enabled }), {
      initialProps: { enabled: true },
    });
    const source = FakeEventSource.instances[0];
    act(() => source.dispatchEvent(new Event('error')));
    if (action === '禁用') view.rerender({ enabled: false });
    else view.unmount();
    act(() => source.dispatchEvent(new MessageEvent('message', { data: '迟到' })));
    await act(() => vi.advanceTimersByTimeAsync(60000));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(received).not.toHaveBeenCalled();
  });

  it('成功接收事件后重置退避，切换对局时清除断点', async () => {
    const view = renderHook(({ url }) => useEventStream(url, vi.fn()), {
      initialProps: { url: '/one' },
    });
    act(() => FakeEventSource.instances[0].dispatchEvent(new Event('error')));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    act(() => FakeEventSource.instances[1].dispatchEvent(new Event('error')));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    act(() =>
      FakeEventSource.instances[2].dispatchEvent(
        new MessageEvent('message', { data: '恢复', lastEventId: '9' }),
      ),
    );
    act(() => FakeEventSource.instances[2].dispatchEvent(new Event('error')));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(FakeEventSource.instances).toHaveLength(4);
    expect(new URL(FakeEventSource.instances[3].url).searchParams.get('after')).toBe('9');
    view.rerender({ url: '/two' });
    expect(FakeEventSource.instances[4].url).toBe('/two');
  });
});
