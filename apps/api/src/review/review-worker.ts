import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
import { loadEnv } from '../config/env';
import { modelRuntimeOf } from '../llm/from-env';
import type { GameStores } from '../store/stores';
import { GAME_STORES } from '../store/stores.provider';
import { REVIEW_QUEUE, type ReviewJob } from './review-queue';
import { runReview } from './workflow';

/** 手动复盘单独排队；失败只保留复盘任务与检查点，不改对局状态。 */
@Processor(REVIEW_QUEUE, { concurrency: 1 })
export class ReviewWorker extends WorkerHost {
  constructor(@Inject(GAME_STORES) private readonly stores: GameStores) {
    super();
  }

  async process(job: Job<ReviewJob>): Promise<void> {
    await runReview(this.stores, job.data.gameId, modelRuntimeOf(loadEnv()));
  }
}
