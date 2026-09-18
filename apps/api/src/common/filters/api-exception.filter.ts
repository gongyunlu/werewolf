import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ApiErrorBody } from '@werewolf/shared';
import type { Response } from 'express';

/**
 * 把所有异常收敛成共享契约 ApiErrorBody。
 * 前端的 ApiError 按同一份定义解析，因此这里的形状不能随意改——改契约要同时改 packages/shared。
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter<unknown> {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    response.status(status).json(this.toBody(exception, status));
  }

  private toBody(exception: unknown, status: number): ApiErrorBody {
    // 5xx 不把内部细节透给调用方，只留服务端日志
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      return { message: '服务器内部错误', code: 'INTERNAL_ERROR' };
    }

    const code = `HTTP_${status}`;

    if (!(exception instanceof HttpException)) {
      return { message: exception instanceof Error ? exception.message : '未知错误', code };
    }

    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return { message: payload, code };
    }

    const { message, code: customCode } = payload as { message?: unknown; code?: unknown };

    return {
      message: Array.isArray(message) ? message.join('；') : String(message ?? exception.message),
      code: typeof customCode === 'string' ? customCode : code,
    };
  }
}
