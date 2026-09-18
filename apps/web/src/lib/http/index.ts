import { HttpClient } from './client';

export { HttpClient } from './client';
export type { HttpClientOptions, RequestConfig, RetryOptions } from './client';
export { ApiError, parseResponse } from './error';
export type { AxiosRequestConfig } from 'axios';

/**
 * 业务接口共用实例。
 * 同 url 的在途请求会被后来的取消；GET 失败最多退避重试两次，写请求从不自动重试。
 */
export const http = new HttpClient({
  baseURL: '/api',
  abortRepetitiveRequest: true,
  retry: { count: 2, baseDelay: 300 },
});
