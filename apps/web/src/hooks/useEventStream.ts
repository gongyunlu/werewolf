import { useEffect, useRef, useState } from 'react';
import { connectionRetryDelay } from '@/lib/connection-retry';

export interface EventStreamState {
  /** 当前是否已连上 */
  connected: boolean;
  /** 最近一次连接失败的原因；连上后清空 */
  error: unknown;
  retry: () => void;
}

export interface UseEventStreamOptions {
  /** 传 false 可暂时不订阅，但仍保留传入的 url */
  enabled?: boolean;
  onExhausted?: () => void;
}

/**
 * 浏览器负责分帧；重连有次数上限，并通过查询参数续接最后收到的事件。
 * onMessage 走 ref 转发，回调变化不会触发重连，调用方不用为它做 memo。
 */
export function useEventStream(
  url: string | null,
  onMessage: (message: MessageEvent<string>) => void,
  options: UseEventStreamOptions = {},
): EventStreamState {
  const { enabled = true } = options;

  const handlerRef = useRef(onMessage);
  const exhaustedRef = useRef(options.onExhausted);
  const retryRef = useRef<(() => void) | null>(null);
  const cursor = useRef({ url, id: '' });

  // 在 effect 里更新而非渲染期赋值：渲染期写 ref 会读到未提交的值
  useEffect(() => {
    handlerRef.current = onMessage;
    exhaustedRef.current = options.onExhausted;
  });

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!enabled || !url) {
      return;
    }

    if (cursor.current.url !== url) cursor.current = { url, id: '' };
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const connect = () => {
      let address = url;
      if (cursor.current.id) {
        const resumed = new URL(url, window.location.href);
        resumed.searchParams.set('after', cursor.current.id);
        address = resumed.href;
      }
      const current = new EventSource(address);
      source = current;
      const receive = (message: MessageEvent<string>) => {
        if (source !== current) return;
        failures = 0;
        if (message.lastEventId) cursor.current.id = message.lastEventId;
        handlerRef.current(message);
      };
      current.addEventListener('message', receive);
      current.addEventListener('preview', receive as EventListener);
      current.addEventListener('open', () => {
        if (source !== current) return;
        setConnected(true);
        setError(null);
      });
      current.addEventListener('error', () => {
        if (source !== current) return;
        current.close();
        source = null;
        setConnected(false);
        const delay = connectionRetryDelay(++failures);
        setError(
          new Error(delay === null ? '事件流连接连续失败，自动重连已停止' : '事件流连接已断开'),
        );
        if (delay === null) exhaustedRef.current?.();
        else timer = setTimeout(connect, delay);
      });
    };
    const retry = () => {
      source?.close();
      clearTimeout(timer);
      failures = 0;
      setConnected(false);
      setError(null);
      connect();
    };
    retryRef.current = retry;
    retry();

    return () => {
      source?.close();
      source = null;
      clearTimeout(timer);
      retryRef.current = null;
      setConnected(false);
    };
  }, [url, enabled]);

  return { connected, error, retry: () => retryRef.current?.() };
}
