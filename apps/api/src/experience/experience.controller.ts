import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ExperienceGenerationResponseSchema,
  ExperienceListSchema,
  ExperienceToggleSchema,
} from '@werewolf/shared';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { AdminTokenGuard } from '../common/guards/admin-token.guard';
import { parseBody } from '../common/parse-body';
import type { GameStores } from '../store/stores';
import type { ExperienceGeneration } from '../store/experiences';
import { GAME_STORES } from '../store/stores.provider';
import { EXPERIENCE_QUEUE, type ExperienceJob } from './experience-queue';
import { experienceSource, REVIEW_VERSION } from './workflow';
import { indexCompleted } from './indexing';

@Controller()
export class ExperienceController {
  constructor(
    @Inject(GAME_STORES) private readonly stores: GameStores,
    @InjectQueue(EXPERIENCE_QUEUE) private readonly queue: Queue<ExperienceJob>,
  ) {}

  @Get('agents/:agentId/experiences')
  async list(@Param('agentId') agentId: string) {
    if (!(await this.stores.agents.find(agentId))) throw new NotFoundException('没有这个 agent');
    return ExperienceListSchema.parse({ experiences: await this.stores.experiences.list(agentId) });
  }

  @Patch('agents/:agentId/experiences/:id')
  @UseGuards(AdminTokenGuard)
  async toggle(@Param('agentId') agentId: string, @Param('id') id: string, @Body() body: unknown) {
    const { enabled } = parseBody(ExperienceToggleSchema, body);
    if (!(await this.stores.experiences.toggle(agentId, id, enabled)))
      throw new NotFoundException('该 agent 没有这条经验');
    return this.list(agentId);
  }

  @Get('experiences/generations/:id')
  async generation(@Param('id') id: string) {
    const row = await this.stores.experiences.findGeneration(id);
    if (!row) throw new NotFoundException('没有这份生成记录');
    return this.view(row);
  }

  @Get('games/:gameId/experience/:playerId')
  async read(@Param('gameId') gameId: string, @Param('playerId') playerId: string) {
    const row = await this.stores.experiences.findSource(gameId, playerId, REVIEW_VERSION);
    if (!row) {
      const { reason } = await experienceSource(this.stores, gameId, playerId);
      return ExperienceGenerationResponseSchema.parse({
        status: reason ? 'unavailable' : 'not_started',
        reason,
        generation: null,
      });
    }
    return this.view(row);
  }

  private async view(row: ExperienceGeneration) {
    const job = await this.queue.getJob(row.id);
    const jobStatus = job ? await job.getState() : null;
    const status = indexCompleted(row.state)
      ? 'completed'
      : jobStatus && jobStatus !== 'completed'
        ? jobStatus
        : row.state.indexing?.failure || row.state.status === 'failed'
          ? 'failed'
          : row.state.result
            ? 'not_indexed'
            : 'interrupted';
    const diagnosis =
      status === 'failed'
        ? row.state.attempts.findLast((item) => item.diagnosis)?.diagnosis
        : undefined;
    const pending =
      row.state.attempts.at(-1)?.status === 'pending' ||
      row.state.indexing?.tasks.some((task) => task.attempts.at(-1)?.status === 'pending');
    return ExperienceGenerationResponseSchema.parse({
      status,
      reason:
        pending && !['active', 'waiting'].includes(status)
          ? '上次请求结果未知；为避免重复调用，已停止自动重发，请核查调用记录'
          : [
              row.state.indexing?.failure ?? row.state.failure,
              diagnosis ? `最近输出校验：${diagnosis}` : null,
            ]
              .filter(Boolean)
              .join('；') || null,
      generation: {
        id: row.id,
        agentId: row.agentId,
        sourceGameId: row.gameId,
        sourcePlayerId: row.playerId,
        reviewVersion: row.reviewVersion,
        status,
        failure: row.state.indexing?.failure ?? row.state.failure,
        result: row.state.result,
        sources: row.state.input?.sources ?? [],
        prompts:
          row.state.input?.prompts.map(({ name, version, source }) => ({
            name,
            version,
            source,
          })) ?? [],
        calls: [
          ...row.state.attempts,
          ...(row.state.indexing?.tasks.flatMap((task) => task.attempts) ?? []),
        ].map((attempt) => ({
          callId: attempt.callId,
          status: attempt.status,
        })),
      },
    });
  }

  @Post('games/:gameId/experience/:playerId')
  @UseGuards(AdminTokenGuard)
  async start(@Param('gameId') gameId: string, @Param('playerId') playerId: string) {
    let row = await this.stores.experiences.findSource(gameId, playerId, REVIEW_VERSION);
    if (!row) {
      const { reason, seat } = await experienceSource(this.stores, gameId, playerId);
      if (reason || !seat) throw new BadRequestException(reason);
      row = await this.stores.experiences.open({
        id: randomUUID(),
        agentId: seat.agentId,
        gameId,
        playerId,
        reviewVersion: REVIEW_VERSION,
      });
    }
    if (indexCompleted(row.state)) return { status: 'completed' };
    let job = await this.queue.getJob(row.id);
    if (job && (await job.getState()) === 'completed') {
      await job.remove();
      job = undefined;
    }
    if (job) {
      if (await job.isFailed()) await job.retry('failed');
    } else
      await this.queue.add('extract', { generationId: row.id }, { jobId: row.id, attempts: 1 });
    return { status: job ? await job.getState() : 'waiting' };
  }
}
