import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ExperienceGenerationResponseSchema,
  ExperienceListSchema,
  ExperienceToggleSchema,
  ExperienceEditSchema,
  ExperienceArchiveSchema,
  ExperienceIndexSchema,
  ExperienceReviewRequestSchema,
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
import { ExperienceConflictError } from '../store/experiences';
import { embeddingKey, embeddingRuntime } from '../llm/embedding';
import { experienceIndexJobId, prepareExperienceIndex } from './maintenance';
import { experienceAudit } from './audit';

async function conflict<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ExperienceConflictError) throw new ConflictException(error.message);
    throw error;
  }
}

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
    const { enabled, revision } = parseBody(ExperienceToggleSchema, body);
    const row = await this.stores.experiences.find(id);
    if (!row || row.item.agentId !== agentId) throw new NotFoundException('该 agent 没有这条经验');
    if (revision === undefined) throw new ConflictException('请刷新经验后携带修订号操作');
    if (
      !(await conflict(() =>
        this.stores.experiences.toggle(
          agentId,
          id,
          enabled,
          revision,
          enabled ? embeddingKey(embeddingRuntime()) : undefined,
        ),
      ))
    )
      throw new NotFoundException('该 agent 没有这条经验');
    return this.list(agentId);
  }

  @Get('agents/:agentId/experiences/:id/audit')
  async audit(@Param('agentId') agentId: string, @Param('id') id: string) {
    const row = await this.stores.experiences.find(id);
    if (!row || row.item.agentId !== agentId) throw new NotFoundException('该 agent 没有这条经验');
    return experienceAudit(this.stores, row.item);
  }

  @Post('agents/:agentId/experiences/:id/review')
  @UseGuards(AdminTokenGuard)
  async review(@Param('agentId') agentId: string, @Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(ExperienceReviewRequestSchema, body);
    if (!(await conflict(() => this.stores.experiences.review(agentId, id, input))))
      throw new NotFoundException('该 agent 没有这条经验');
    return this.list(agentId);
  }

  @Put('agents/:agentId/experiences/:id/content')
  @UseGuards(AdminTokenGuard)
  async edit(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const { revision, content } = parseBody(ExperienceEditSchema, body);
    if (!(await conflict(() => this.stores.experiences.edit(agentId, id, revision, content))))
      throw new NotFoundException('该 agent 没有这条经验');
    return this.list(agentId);
  }

  @Patch('agents/:agentId/experiences/:id/archive')
  @UseGuards(AdminTokenGuard)
  async archive(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const { revision, archived } = parseBody(ExperienceArchiveSchema, body);
    if (!(await conflict(() => this.stores.experiences.archive(agentId, id, revision, archived))))
      throw new NotFoundException('该 agent 没有这条经验');
    return this.list(agentId);
  }

  @Post('agents/:agentId/experiences/:id/index')
  @UseGuards(AdminTokenGuard)
  async index(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const { version } = parseBody(ExperienceIndexSchema, body);
    const row = await this.stores.experiences.find(id);
    if (!row || row.item.agentId !== agentId) throw new NotFoundException('该 agent 没有这条经验');
    if (row.item.version !== version) throw new ConflictException('经验已被修改，请刷新后重试');
    if (row.item.archived) throw new ConflictException('请先恢复归档经验，再建立索引');
    if (version === 1 && row.state === null) {
      const generation = (await this.stores.experiences.findGeneration(row.item.generationId))!;
      if (!indexCompleted(generation.state)) {
        await this.start(row.item.sourceGameId, row.item.sourcePlayerId);
        return this.list(agentId);
      }
    }
    const jobId = experienceIndexJobId(id, version);
    const job = await this.queue.getJob(jobId);
    if (job && ['active', 'waiting', 'delayed'].includes(await job.getState()))
      return this.list(agentId);
    await conflict(() => prepareExperienceIndex(this.stores, row, embeddingRuntime()));
    if ((await this.stores.experiences.find(id))!.state?.status === 'ready')
      return this.list(agentId);
    if (job) await job.remove();
    await this.queue.add('index', { experienceId: id, version }, { jobId, attempts: 1 });
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
