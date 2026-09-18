import type { EventSourceMessage } from 'eventsource-parser';
import { useEffect, useRef, useState } from 'react';
import { openEventStream } from '@/lib/sse';

export interface EventStreamState {
  /** 当前是否已连上 */
  connected: boolean;
  /** 最近一次连接失败的原因；连上后清空 */
  error: unknown;
}

export interface UseEventStreamOptions {
  /** 传 false 可暂时不订阅，但仍保留传入的 url */
  enabled?: boolean;
}

/**
 * 把事件流绑到组件生命周期上：挂载订阅、卸载关闭。
 *
 * 传输与分帧仍在 lib/sse.ts，这一层只负责生命周期与连接状态。
 * onMessage 通过 ref 转发，因此调用方不必为它做 memo——回调变化不会触发重连。
 */
export function useEventStream(
  url: string | null,
  onMessage: (message: EventSourceMessage) => void,
  options: UseEventStreamOptions = {},
): EventStreamState {
  const { enabled = true } = options;

  const handlerRef = useRef(onMessage);

  // 在 effect 里更新而非渲染期赋值：渲染期写 ref 会读到未提交的值
  useEffect(() => {
    handlerRef.current = onMessage;
  });

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!enabled || !url) {
      return;
    }

    const handle = openEventStream(url, {
      handlers: {
        onMessage: (message) => handlerRef.current(message),
        onOpen: () => {
          setConnected(true);
          setError(null);
        },
        onError: (failure) => {
          setConnected(false);
          setError(failure);
        },
      },
    });

    return () => {
      handle.close();
      void handle.closed;
      setConnected(false);
    };
  }, [url, enabled]);

  return { connected, error };
}
