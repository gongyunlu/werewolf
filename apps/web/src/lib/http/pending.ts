import type { AxiosRequestConfig } from 'axios';

function fingerprint(value: unknown): string {
  if (value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // 循环引用等拿不到稳定表示的值一律当作空，退化成不按该维度区分
    return '';
  }
}

/** 参数或正文不同的两个请求是两回事，不能算同一个键 */
function keyOf(config: AxiosRequestConfig): string {
  return `${config.method ?? 'get'}:${config.url ?? ''}:${fingerprint(config.params)}:${fingerprint(config.data)}`;
}

/**
 * 同一 method + url + params + data 只留最后一次：新来的取消还没完成的旧请求，
 * 免得先发的响应晚到把后发的结果覆盖掉。
 */
export class PendingRequests {
  private readonly controllers = new Map<string, AbortController>();

  /**
   * 登记一次请求。返回的 signal 已合并调用方的，任一方中止都能结束请求；
   * release 在本请求收尾时调。
   */
  register(config: AxiosRequestConfig, callerSignal?: AbortSignal) {
    const key = keyOf(config);
    this.abort(key);

    const controller = new AbortController();
    this.controllers.set(key, controller);

    return {
      signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
      release: () => {
        // 只清理仍属于本次请求的条目，避免把后发的同键请求一起摘掉
        if (this.controllers.get(key) === controller) {
          this.controllers.delete(key);
        }
      },
    };
  }

  abortAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
  }

  private abort(key: string): void {
    const controller = this.controllers.get(key);

    if (controller) {
      controller.abort();
      this.controllers.delete(key);
    }
  }
}
