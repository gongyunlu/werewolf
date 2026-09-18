import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios';
import type { ZodType } from 'zod';
import { parseResponse, toApiError } from './error';
import { PendingRequests } from './pending';

declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 本次请求是否在出现同类在途请求时取消它；缺省沿用实例配置 */
    abortRepetitiveRequest?: boolean;
    /** 内部使用：记录重试次数与本次请求的清理函数 */
    retryAttempt?: number;
    releasePending?: () => void;
  }
}

export interface RetryOptions {
  /** 最多重试几次 */
  count: number;
  /** 首次退避毫秒数，之后逐次翻倍 */
  baseDelay: number;
}

export interface HttpClientOptions extends AxiosRequestConfig {
  abortRepetitiveRequest?: boolean;
  retry?: RetryOptions;
}

/** 单次请求配置：在 axios 配置之上增加可选的响应契约校验 */
export interface RequestConfig<T> extends AxiosRequestConfig {
  schema?: ZodType<T>;
}

/** 只有幂等请求可以自动重试；POST/PUT/PATCH/DELETE 一律不重试 */
const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options']);

function isRetryable(error: AxiosError): boolean {
  const method = (error.config?.method ?? 'get').toLowerCase();

  if (!IDEMPOTENT_METHODS.has(method)) {
    return false;
  }

  // 主动取消（被同键请求顶掉、abortAll）不是故障：重试只会让旧请求反过来把后发的请求取消掉
  if (axios.isCancel(error)) {
    return false;
  }

  // 没拿到响应说明是网络层问题，值得重试
  if (!error.response) {
    return true;
  }

  return error.response.status >= 500 || error.response.status === 429;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpClient {
  private readonly instance: AxiosInstance;
  private readonly pending = new PendingRequests();
  private readonly abortRepetitiveRequest: boolean;
  private readonly retry: RetryOptions | undefined;

  constructor(options: HttpClientOptions = {}) {
    const { abortRepetitiveRequest = false, retry, ...axiosConfig } = options;

    this.abortRepetitiveRequest = abortRepetitiveRequest;
    this.retry = retry;
    this.instance = axios.create(axiosConfig);
    this.registerInterceptors();
  }

  get<T>(url: string, config: RequestConfig<T> = {}): Promise<T> {
    return this.request<T>({ ...config, url, method: 'GET' });
  }

  post<T>(url: string, data?: unknown, config: RequestConfig<T> = {}): Promise<T> {
    return this.request<T>({ ...config, url, data, method: 'POST' });
  }

  put<T>(url: string, data?: unknown, config: RequestConfig<T> = {}): Promise<T> {
    return this.request<T>({ ...config, url, data, method: 'PUT' });
  }

  delete<T>(url: string, config: RequestConfig<T> = {}): Promise<T> {
    return this.request<T>({ ...config, url, method: 'DELETE' });
  }

  /** 取消所有在途请求，用于整页卸载等场景 */
  abortAll(): void {
    this.pending.abortAll();
  }

  private async request<T>(config: RequestConfig<T>): Promise<T> {
    const { schema, ...axiosConfig } = config;
    const response = await this.instance.request<unknown, AxiosResponse<unknown>>(axiosConfig);

    return parseResponse(schema, response.data);
  }

  private registerInterceptors(): void {
    this.instance.interceptors.request.use((config) => {
      const shouldAbort = config.abortRepetitiveRequest ?? this.abortRepetitiveRequest;

      // 重试沿用同一个 config，此时它已经登记过。重新登记会把后发的同键请求取消掉，
      // 也会让自己的 signal 被换成已中止的那个，所以重试必须复用原来的登记。
      if (shouldAbort && !config.releasePending) {
        const { signal, release } = this.pending.register(
          config,
          config.signal instanceof AbortSignal ? config.signal : undefined,
        );

        config.signal = signal;
        config.releasePending = release;
      }

      return config;
    });

    this.instance.interceptors.response.use(
      (response) => {
        response.config.releasePending?.();
        return response;
      },
      async (error: unknown) => {
        if (!axios.isAxiosError(error)) {
          throw toApiError(error);
        }

        // 还要重试就先留着登记，这样后发的同键请求依然能取消这次重试
        if (this.canRetry(error)) {
          return this.retryRequest(error);
        }

        error.config?.releasePending?.();

        throw toApiError(error);
      },
    );
  }

  private canRetry(error: AxiosError): boolean {
    if (!this.retry || !error.config) {
      return false;
    }

    if (!isRetryable(error)) {
      return false;
    }

    return (error.config.retryAttempt ?? 0) < this.retry.count;
  }

  private async retryRequest(error: AxiosError): Promise<AxiosResponse> {
    const config = error.config as AxiosRequestConfig;
    const attempt = config.retryAttempt ?? 0;

    config.retryAttempt = attempt + 1;
    await delay(this.retry!.baseDelay * 2 ** attempt);

    return this.instance.request(config);
  }
}
