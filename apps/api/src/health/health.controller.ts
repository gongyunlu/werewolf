import { Controller, Get } from '@nestjs/common';
import { HealthResponseSchema, type HealthResponse } from '@werewolf/shared';

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    // 走一遍共享契约，别让实现悄悄偏离约定
    return HealthResponseSchema.parse({ status: 'ok' });
  }
}
