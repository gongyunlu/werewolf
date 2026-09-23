import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventStream } from './useEventStream';

/** 只模拟浏览器事件，SSE 解析和重连不再由应用实现。 */
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  close = vi.fn();

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
}

describe('useEventStream', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('接收事实和预览，断开时清除连接状态，重连后清除错误', () => {
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
    act(() => source.dispatchEvent(new Event('open')));
    expect(result.current.connected).toBe(true);
    expect(result.current.error).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(1);
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
});
