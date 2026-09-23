import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** 管理令牌的头名。前端按它带，写在这儿只此一份。 */
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

/**
 * 管理写接口的守卫。
 * 没配 ADMIN_TOKEN 时一律拒：本机上没设凭据还照样能写，等于那些接口一直开着。
 * 读接口不挂它——对局与配置本来就是给自己看的。
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.ADMIN_TOKEN ?? '';
    if (expected === '') {
      throw new ServiceUnavailableException('没配 ADMIN_TOKEN，管理写接口一律拒');
    }

    const given = context.switchToHttp().getRequest<Request>().headers[ADMIN_TOKEN_HEADER];
    if (typeof given !== 'string' || !sameToken(given, expected)) {
      throw new UnauthorizedException('管理令牌不对');
    }

    return true;
  }
}

/** 定长比较：长度不等直接判否，不进 timingSafeEqual——它要求两边等长，不等会抛。 */
function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);

  return a.length === b.length && timingSafeEqual(a, b);
}
