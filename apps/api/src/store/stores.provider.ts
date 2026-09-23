import type { Provider } from '@nestjs/common';
import { loadEnv } from '../config/env';
import type { PrismaClient } from '../generated/prisma/client';
import { openPrismaClient, prismaStores } from './prisma';
import type { GameStores } from './stores';

/** 存储的注入令牌。用接口做类型的地方都得靠令牌注进去，用例把它换成内存那一份。 */
export const GAME_STORES = Symbol('GAME_STORES');

/** 连接本身的令牌。只有要关它的那一处用得上，读接口拿到的都是上面那份存储。 */
export const PRISMA_CLIENT = Symbol('PRISMA_CLIENT');

/**
 * 服务里给出去的那一份存储：连的是环境里那个库，读不到连接串当场抛，不猜。
 * 跑一局用的是命令行那一头，它自己开自己关；这里只管「服务起来之后有人来读」。
 */
export const gameStoresProvider: Provider = {
  provide: GAME_STORES,
  useFactory: (client: PrismaClient): GameStores => prismaStores(client),
  inject: [PRISMA_CLIENT],
};

/** 连接由容器管着，好让退出时能有地方把它关掉。 */
export const prismaClientProvider: Provider = {
  provide: PRISMA_CLIENT,
  useFactory: (): PrismaClient => openPrismaClient(loadEnv().DATABASE_URL),
};
