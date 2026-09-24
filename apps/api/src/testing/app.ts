import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { REDIS_PUB, REDIS_SUB } from '../queue/game-event-hub';
import { GAME_QUEUE } from '../queue/game-queue';
import { GameWorker } from '../queue/game-worker';
import { REVIEW_QUEUE } from '../review/review-queue';
import { ReviewWorker } from '../review/review-worker';
import type { GameStores } from '../store/stores';
import { GAME_STORES, PRISMA_CLIENT } from '../store/stores.provider';
import { FakeRedis } from './stream';

/** 接口测试保留应用装配，替换所有外部连接。 */
export function testAppModule(stores: GameStores) {
  return Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GAME_STORES)
    .useValue(stores)
    .overrideProvider(PRISMA_CLIENT)
    .useValue({ $disconnect: async () => {} })
    .overrideProvider(getQueueToken(GAME_QUEUE))
    .useValue({})
    .overrideProvider(getQueueToken(REVIEW_QUEUE))
    .useValue({})
    .overrideProvider(REDIS_PUB)
    .useValue(new FakeRedis())
    .overrideProvider(REDIS_SUB)
    .useValue(new FakeRedis())
    .overrideProvider(GameWorker)
    .useValue({})
    .overrideProvider(ReviewWorker)
    .useValue({});
}
