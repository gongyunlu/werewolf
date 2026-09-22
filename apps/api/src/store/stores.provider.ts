import type { Provider } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { openPrismaClient, prismaStores } from './prisma';
import type { GameStores } from './stores';

/** 存储的注入令牌。用接口做类型的地方都得靠令牌注进去，用例把它换成内存那一份。 */
export const GAME_STORES = Symbol('GAME_STORES');

/**
 * 服务里给出去的那一份存储：连的是环境里那个库，读不到连接串当场抛，不猜。
 * 跑一局用的是命令行那一头，它自己开自己关；这里只管「服务起来之后有人来读」。
 */
export const gameStoresProvider: Provider = {
  provide: GAME_STORES,
  useFactory: (): GameStores => prismaStores(openPrismaClient(loadEnv().DATABASE_URL)),
};
