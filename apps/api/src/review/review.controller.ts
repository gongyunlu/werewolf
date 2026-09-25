import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AdminTokenGuard } from '../common/guards/admin-token.guard';
import type { GameStores } from '../store/stores';
import { GAME_STORES } from '../store/stores.provider';
import { finishedGame, prepareEvidence, reviewPreview } from './evidence';
import { REVIEW_QUEUE, type ReviewJob } from './review-queue';
import { readReview, readReviewState } from './workflow';

@Controller('games/:gameId/review')
export class ReviewController {
  constructor(
    @Inject(GAME_STORES) private readonly stores: GameStores,
    @InjectQueue(REVIEW_QUEUE) private readonly queue: Queue<ReviewJob>,
  ) {}

  @Get('preview')
  async preview(@Param('gameId') gameId: string) {
    return reviewPreview(
      (await readReviewState(this.stores, gameId))?.evidence ??
        (await prepareEvidence(this.stores, gameId)),
    );
  }

  @Get()
  async read(@Param('gameId') gameId: string) {
    await finishedGame(this.stores, gameId);
    const [report, job] = await Promise.all([
      readReview(this.stores, gameId),
      this.queue.getJob(gameId),
    ]);
    const status = report?.completedAt
      ? 'completed'
      : job
        ? await job.getState()
        : report
          ? 'interrupted'
          : 'not_started';
    return {
      status,
      report,
      failure:
        status === 'failed' ? '复盘任务失败；已保存的结果可续跑，失败不代表玩家表现差' : null,
    };
  }

  @Post()
  @UseGuards(AdminTokenGuard)
  async start(@Param('gameId') gameId: string) {
    await finishedGame(this.stores, gameId);
    if ((await readReviewState(this.stores, gameId))?.completedAt) return { status: 'completed' };
    const job = await this.queue.getJob(gameId);
    if (job) {
      if (await job.isFailed()) await job.retry('failed');
      return { status: await job.getState() };
    } else {
      // 保留完成的任务，重复提交由队列的唯一 id 合并；失败续跑不删除再入队。
      await this.queue.add('review', { gameId }, { jobId: gameId, attempts: 1 });
    }
    return { status: 'waiting' };
  }
}
