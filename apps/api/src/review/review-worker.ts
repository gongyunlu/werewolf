import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { DelayedError, type Job } from 'bullmq';
import type { GameStores } from '../store/stores';
import { GAME_STORES } from '../store/stores.provider';
import { REVIEW_QUEUE, type ReviewJob } from './review-queue';
import { readReviewState, runReview } from './workflow';
import { ReviewFailedError, ReviewPendingError } from './platform';

/** 连续多少轮没有单元完成就停下等人工。 */
export const REVIEW_WAIT_LIMIT = 5;

/** 手动复盘单独排队；失败只保留复盘任务与检查点，不改对局状态。 */
@Processor(REVIEW_QUEUE, { concurrency: 1 })
export class ReviewWorker extends WorkerHost {
  constructor(@Inject(GAME_STORES) private readonly stores: GameStores) {
    super();
  }

  async process(job: Job<ReviewJob>, token?: string): Promise<void> {
    const retryFailed = job.data.retryFailed ?? true;
    // 每轮只放行一次重投；用户续跑和判定失败重投都从这里重新计时。
    if (retryFailed) await job.updateData({ ...job.data, retryFailed: false, waits: 0 });
    try {
      await runReview(this.stores, job.data.gameId, undefined, retryFailed);
    } catch (error) {
      if (!(error instanceof ReviewPendingError) && !(error instanceof ReviewFailedError))
        throw error;
      const progress = (await readReviewState(this.stores, job.data.gameId))?.receipts.length ?? 0;
      const waits = (job.data.progress === progress ? (job.data.waits ?? 0) : 0) + 1;
      // 一直没有单元完成就停下等人，不再无限延迟。
      if (waits > REVIEW_WAIT_LIMIT)
        throw new Error(`Langfuse 评价连续 ${REVIEW_WAIT_LIMIT} 轮没有结果，请核查平台后续跑`, {
          cause: error,
        });
      // 判定失败下发放一次重投；结果未到只续读，避免白花模型调用。
      await job.updateData({
        ...job.data,
        progress,
        waits,
        retryFailed: error instanceof ReviewFailedError,
      });
      await job.moveToDelayed(Date.now() + 5_000, token);
      throw new DelayedError();
    }
  }
}
