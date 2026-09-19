import { createParser, type EventSourceMessage } from 'eventsource-parser';

/**
 * 事件流不走 axios：浏览器端 axios 基于 XHR，响应体会被整体缓冲，拿不到逐帧到达的数据。
 * 错误只走 onError，不从 closed 抛——断开是长连接的常态，不该逼调用方去 catch Promise。
 */
export class EventStreamError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'EventStreamError';
    this.status = status;
  }

  /** 4xx（429 除外）说明请求本身有问题，重试没意义；没有 status 表示网络层失败 */
  get retryable(): boolean {
    if (this.status === undefined) {
      return true;
    }

    return this.status >= 500 || this.status === 429;
  }
}

export interface EventStreamHandlers {
  /** 每解析出一条完整消息触发一次 */
  onMessage: (message: EventSourceMessage) => void;
  /** 连接建立时触发，reconnected 表示这次是重连 */
  onOpen?: (reconnected: boolean) => void;
  /** 一次连接尝试失败时触发，后面还可能重连 */
  onError?: (error: unknown) => void;
}

export interface EventStreamOptions {
  handlers: EventStreamHandlers;
  /** 重连退避毫秒序列，用尽后停止重连；传空数组表示断开即结束 */
  retryDelays?: number[];
}

export interface EventStreamHandle {
  close: () => void;
  /** 连接彻底结束后完成；正常结束或重连耗尽都算 */
  closed: Promise<void>;
}

const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000, 8000];

function abortError(): DOMException {
  return new DOMException('事件流已关闭', 'AbortError');
}

export function openEventStream(url: string, options: EventStreamOptions): EventStreamHandle {
  const { handlers, retryDelays = DEFAULT_RETRY_DELAYS } = options;
  const controller = new AbortController();

  let lastEventId: string | undefined;
  let attempt = 0;
  let openedBefore = false;

  function wait(ms: number): Promise<void> {
    if (controller.signal.aborted) {
      return Promise.reject(abortError());
    }

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;

      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };

      timer = setTimeout(() => {
        // 正常到期时摘掉监听器，否则每次退避都会在 signal 上留一个收不回的闭包
        controller.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function connectOnce(): Promise<void> {
    // 重连时带上上次的事件 id，服务端据此从断点续发
    const headers: Record<string, string> = { Accept: 'text/event-stream' };

    if (lastEventId !== undefined) {
      headers['Last-Event-ID'] = lastEventId;
    }

    const response = await fetch(url, { headers, signal: controller.signal });

    if (!response.ok) {
      throw new EventStreamError(`事件流连接失败：${response.status}`, response.status);
    }

    if (!response.body) {
      throw new EventStreamError('事件流响应没有正文');
    }

    handlers.onOpen?.(openedBefore);
    openedBefore = true;

    const parser = createParser({
      onEvent: (message) => {
        // 只有真收到消息才说明连接可用，退避从此刻重新计起。
        // 建连时就清零的话，服务端每次收下请求再立刻关流，退避会永远停在第一档。
        attempt = 0;

        if (message.id !== undefined) {
          lastEventId = message.id;
        }

        handlers.onMessage(message);
      },
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    for (;;) {
      const { value, done } = await reader.read();

      if (done) {
        return;
      }

      // stream: true 让跨 chunk 的多字节字符等到后续字节再解码，否则中文会乱码
      parser.feed(decoder.decode(value, { stream: true }));
    }
  }

  const closed = (async () => {
    for (;;) {
      let failure: unknown;

      try {
        await connectOnce();
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        failure = error;
        handlers.onError?.(error);
      }

      if (failure instanceof EventStreamError && !failure.retryable) {
        return;
      }

      if (attempt >= retryDelays.length) {
        return;
      }

      try {
        await wait(retryDelays[attempt]!);
      } catch {
        return;
      }

      attempt += 1;
    }
  })();

  return {
    closed,
    close: () => controller.abort(),
  };
}
