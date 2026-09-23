import { HealthResponseSchema } from '@werewolf/shared';
import { AxiosError, AxiosHeaders, CanceledError } from 'axios';
import { describe, expect, it } from 'vitest';
import { ApiError, isCanceled, parseResponse, toApiError } from './error';

describe('toApiError', () => {
  it('原样返回已经是 ApiError 的错误', () => {
    const original = new ApiError('已经归一化');

    expect(toApiError(original)).toBe(original);
  });

  it('把 axios 响应错误转成含状态码的 ApiError', () => {
    const headers = new AxiosHeaders();
    const error = new AxiosError('请求失败', 'ERR_BAD_REQUEST', undefined, undefined, {
      data: { message: '对局不存在', code: 'GAME_NOT_FOUND' },
      status: 404,
      statusText: 'Not Found',
      headers,
      config: { headers },
    });

    expect(toApiError(error)).toMatchObject({
      name: 'ApiError',
      message: '对局不存在',
      status: 404,
      code: 'GAME_NOT_FOUND',
    });
  });

  it('没有响应体时退回 axios 自带消息，状态码缺省', () => {
    const error = new AxiosError('网络中断', 'ERR_NETWORK');

    expect(toApiError(error)).toMatchObject({ message: '网络中断', status: undefined });
  });

  it('普通 Error 保留消息', () => {
    expect(toApiError(new Error('随便什么错')).message).toBe('随便什么错');
  });

  it('响应体不符合共享契约时，退回 axios 自带消息', () => {
    const error = new AxiosError('请求失败', 'ERR_BAD_RESPONSE', undefined, undefined, {
      // 少了 code，不是合法的 ApiErrorBody
      data: { message: '只有消息没有 code' },
      status: 400,
      statusText: 'Bad Request',
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
    });

    expect(toApiError(error).message).toBe('请求失败');
  });

  it('被取消的请求给一个自己的码，调用方一眼认得出不是故障', () => {
    const canceled = toApiError(new CanceledError('canceled'));

    expect(canceled.code).toBe('CANCELED');
    expect(isCanceled(canceled)).toBe(true);
    expect(isCanceled(new ApiError('别的错', { code: 'HTTP_500' }))).toBe(false);
    expect(isCanceled(new Error('压根不是这一路的错'))).toBe(false);
  });
});

describe('parseResponse', () => {
  it('没有传契约时原样返回', () => {
    expect(parseResponse(undefined, { 随便: '什么' })).toEqual({ 随便: '什么' });
  });

  it('符合契约时返回解析结果', () => {
    expect(parseResponse(HealthResponseSchema, { status: 'ok' })).toEqual({ status: 'ok' });
  });

  it('不符合契约时抛出可识别的 ApiError', () => {
    const error: unknown = (() => {
      try {
        parseResponse(HealthResponseSchema, { status: 'degraded' });
        return null;
      } catch (caught: unknown) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'RESPONSE_SCHEMA_MISMATCH' });
  });
});
