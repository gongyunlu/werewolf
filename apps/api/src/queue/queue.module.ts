import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env';
import { StoresModule } from '../store/stores.module';
import { GameEventHub, REDIS_PUB, REDIS_SUB } from './game-event-hub';
import { GAME_QUEUE } from './game-queue';
import { GameWorker } from './game-worker';
import { REVIEW_QUEUE } from '../review/review-queue';
import { ReviewWorker } from '../review/review-worker';
import { EXPERIENCE_QUEUE } from '../experience/experience-queue';
import { ExperienceWorker } from '../experience/experience-worker';

/**
 * 跑局那一层：入队、出队、把跑出来的事实推给正在看的人。
 * 队列与中转都在接口这个进程里，起服务就是起队列。
 */
@Module({
  imports: [
    StoresModule,
    // 连接在工厂里现读环境：装饰器那一层求值时 .env 还没加载进来。
    BullModule.forRootAsync({
      useFactory: () => ({ connection: { url: loadEnv().REDIS_URL } }),
    }),
    BullModule.registerQueue({ name: GAME_QUEUE }),
    BullModule.registerQueue({ name: REVIEW_QUEUE }),
    BullModule.registerQueue({ name: EXPERIENCE_QUEUE }),
  ],
  providers: [
    // 队列自己开自己的连接，这两条只给事件中转用：一条发、一条收。
    { provide: REDIS_PUB, useFactory: (): Redis => new Redis(loadEnv().REDIS_URL) },
    { provide: REDIS_SUB, useFactory: (): Redis => new Redis(loadEnv().REDIS_URL) },
    GameEventHub,
    GameWorker,
    ReviewWorker,
    ExperienceWorker,
  ],
  exports: [BullModule, GameEventHub],
})
export class QueueModule {}
