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

/** 所有异常统一收敛成共享契约 ApiErrorBody（形状见 packages/shared 的 api/error.ts）。 */
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
