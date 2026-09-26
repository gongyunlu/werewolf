import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
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
  KnowledgeActivateSchema,
  KnowledgeItemSchema,
  KnowledgeListSchema,
  KnowledgeSaveSchema,
} from '@werewolf/shared';
import type { Queue } from 'bullmq';
import { ALL_BOARDS, type BoardId } from '../boards/boards';
import { AdminTokenGuard } from '../common/guards/admin-token.guard';
import { parseBody } from '../common/parse-body';
import { embeddingKey, embeddingRuntime } from '../llm/embedding';
import { KnowledgeConflictError, type KnowledgeRecord } from '../store/knowledge';
import type { GameStores } from '../store/stores';
import { GAME_STORES } from '../store/stores.provider';
import { prepareKnowledgeIndex } from './indexing';
import { KNOWLEDGE_QUEUE, type KnowledgeJob } from './knowledge-queue';

export function knowledgeView(row: KnowledgeRecord) {
  return KnowledgeItemSchema.parse({
    ...row,
    versions: row.versions.map((v) => ({
      ...v,
      status: v.state.status,
      failure: v.state.failure,
      model: v.state.task?.model ?? null,
    })),
  });
}
async function conflict<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof KnowledgeConflictError) throw new ConflictException(error.message);
    throw error;
  }
}

@Controller('knowledge')
export class KnowledgeController {
  constructor(
    @Inject(GAME_STORES) private readonly stores: GameStores,
    @InjectQueue(KNOWLEDGE_QUEUE) private readonly queue: Queue<KnowledgeJob>,
  ) {}

  @Get()
  async list() {
    return KnowledgeListSchema.parse({
      items: (await this.stores.knowledge.list()).map(knowledgeView),
    });
  }

  @Get(':id')
  async read(@Param('id', ParseUUIDPipe) id: string) {
    const row = await this.stores.knowledge.find(id);
    if (!row) throw new NotFoundException('没有这条知识');
    return knowledgeView(row);
  }

  @Put(':id/draft')
  @UseGuards(AdminTokenGuard)
  async save(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { revision, content } = parseBody(KnowledgeSaveSchema, body);
    for (const boardId of content.boardIds) {
      const board = ALL_BOARDS[boardId as BoardId];
      if (!board || content.roles.some((role) => !(role in board.roles)))
        throw new BadRequestException('板子不存在或不包含所选角色，请分别整理适用范围');
    }
    return knowledgeView(
      await conflict(() => this.stores.knowledge.saveDraft(id, revision, content)),
    );
  }

  @Patch(':id/active')
  @UseGuards(AdminTokenGuard)
  async activate(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { revision, versionId } = parseBody(KnowledgeActivateSchema, body);
    await conflict(() =>
      this.stores.knowledge.activate(
        id,
        revision,
        versionId,
        versionId ? embeddingKey(embeddingRuntime()) : '',
      ),
    );
    return this.read(id);
  }

  @Get('versions/:id/calls')
  async calls(@Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.stores.knowledge.version(id))) throw new NotFoundException('没有这个版本');
    return this.stores.asked.knowledgeCalls(id);
  }

  @Post('versions/:id/index')
  @UseGuards(AdminTokenGuard)
  async index(@Param('id', ParseUUIDPipe) id: string) {
    const row = await this.stores.knowledge.version(id);
    if (!row) throw new NotFoundException('没有这个版本');
    let job = await this.queue.getJob(id);
    if (job && ['active', 'waiting', 'delayed'].includes(await job.getState()))
      return this.read(row.id);
    await conflict(() => prepareKnowledgeIndex(this.stores, row, embeddingRuntime()));
    if ((await this.stores.knowledge.version(id))!.state.status === 'ready')
      return this.read(row.id);
    if (job) {
      await job.remove();
      job = undefined;
    }
    await this.queue.add('index', { versionId: id }, { jobId: id, attempts: 1 });
    return this.read(row.id);
  }
}
