import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client';
import {
  gameStoresProvider,
  GAME_STORES,
  PRISMA_CLIENT,
  prismaClientProvider,
} from './stores.provider';

/**
 * 存储按模块装配：几处读接口共用这一个连接池，不然每加一个模块就多开一份。
 * 进程退出时把连接关掉，不关的话那几个连接要挂在那儿等对端超时。
 */
@Module({
  providers: [prismaClientProvider, gameStoresProvider],
  exports: [GAME_STORES],
})
export class StoresModule implements OnApplicationShutdown {
  constructor(@Inject(PRISMA_CLIENT) private readonly client: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.$disconnect();
  }
}
