import { HttpClient } from './client';

export { HttpClient } from './client';
export type { HttpClientOptions, RequestConfig, RetryOptions } from './client';
export { ApiError, parseResponse } from './error';
export type { AxiosRequestConfig } from 'axios';

/** 业务接口共用实例：同键在途请求被后来的顶掉；GET 失败最多退避重试两次。 */
export const http = new HttpClient({
  baseURL: '/api',
  abortRepetitiveRequest: true,
  retry: { count: 2, baseDelay: 300 },
});
