import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { ApiErrorBodySchema } from '@werewolf/shared';
import { ApiExceptionFilter } from './api-exception.filter';

function bodyOf(exception: unknown) {
  let statusCode: number | undefined;
  let responseBody: unknown;

  const status = jest.fn((code: number) => {
    statusCode = code;
    return { json };
  });

  const json = jest.fn((body: unknown) => {
    responseBody = body;
  });

  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;

  new ApiExceptionFilter().catch(exception, host);

  return { status: statusCode, body: responseBody };
}

describe('ApiExceptionFilter', () => {
  it('HttpException 转成共享契约，保留状态码与消息', () => {
    const { status, body } = bodyOf(new NotFoundException('对局不存在'));

    expect(status).toBe(HttpStatus.NOT_FOUND);
    expect(ApiErrorBodySchema.parse(body)).toEqual({
      message: '对局不存在',
      code: 'HTTP_404',
    });
  });

  it('校验失败时把消息数组合并成一条', () => {
    const { body } = bodyOf(
      new BadRequestException({ message: ['target 必填', 'target 必须是数字'] }),
    );

    expect(body).toMatchObject({ message: 'target 必填；target 必须是数字' });
  });

  it('异常自带 code 时优先使用', () => {
    const { body } = bodyOf(
      new HttpException({ message: '已提交过', code: 'DUPLICATE_SUBMISSION' }, HttpStatus.CONFLICT),
    );

    expect(body).toMatchObject({ code: 'DUPLICATE_SUBMISSION' });
  });

  it('未预期的异常返回 500，且不泄露内部信息', () => {
    const { status, body } = bodyOf(new Error('数据库连接串是 postgres://secret'));

    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body).toEqual({ message: '服务器内部错误', code: 'INTERNAL_ERROR' });
  });

  it('任意响应体都满足共享契约', () => {
    const exceptions: unknown[] = [
      new NotFoundException(),
      new BadRequestException('参数不对'),
      new Error('boom'),
      'not-an-error',
    ];

    for (const exception of exceptions) {
      const { body } = bodyOf(exception);
      expect(ApiErrorBodySchema.safeParse(body).success).toBe(true);
    }
  });
});
