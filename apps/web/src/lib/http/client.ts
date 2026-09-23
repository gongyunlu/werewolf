import axios, { type AxiosRequestConfig } from 'axios';
import type { ZodType } from 'zod';
import { parseResponse, toApiError } from './error';

interface RequestConfig<T> extends AxiosRequestConfig {
  schema?: ZodType<T>;
}

/** 统一响应校验与错误格式，请求取消由发起者的 signal 控制。 */
export function createHttpClient(options: AxiosRequestConfig = {}) {
  const client = axios.create(options);

  async function request<T>({ schema, ...config }: RequestConfig<T>): Promise<T> {
    try {
      const response = await client.request<unknown>(config);
      return parseResponse(schema, response.data);
    } catch (error) {
      throw toApiError(error);
    }
  }

  return {
    get: <T>(url: string, config: RequestConfig<T> = {}) =>
      request<T>({ ...config, url, method: 'GET' }),
    post: <T>(url: string, data?: unknown, config: RequestConfig<T> = {}) =>
      request<T>({ ...config, url, data, method: 'POST' }),
    put: <T>(url: string, data?: unknown, config: RequestConfig<T> = {}) =>
      request<T>({ ...config, url, data, method: 'PUT' }),
    patch: <T>(url: string, data?: unknown, config: RequestConfig<T> = {}) =>
      request<T>({ ...config, url, data, method: 'PATCH' }),
  };
}
