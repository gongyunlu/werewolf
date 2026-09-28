import { InjectQueue } from '@nestjs/bullmq';
import {
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
import { validateKnowledgeContent, validateKnowledgeSources } from './content-validation';
import { AdminTokenGuard } from '../common/guards/admin-token.guard';
import { parseBody } from '../common/parse-body';
import { embeddingKey, embeddingRuntime } from '../llm/embedding';
import { KnowledgeConflictError, type KnowledgeRecord } from '../store/knowledge';
import type { GameStores } from '../store/stores';
import { GAME_STORES } from '../store/stores.provider';
import { enqueueKnowledgeIndex } from './indexing';
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
    validateKnowledgeContent(content);
    await validateKnowledgeSources(this.stores, content);
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
    await conflict(() => enqueueKnowledgeIndex(this.stores, this.queue, row));
    return this.read(row.id);
  }
}
