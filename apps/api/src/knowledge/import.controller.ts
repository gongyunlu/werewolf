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
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  KnowledgeBulkActionSchema,
  KnowledgeBulkResultSchema,
  KnowledgeCandidateSaveSchema,
  KnowledgeCaptureSchema,
  KnowledgeCapturesSchema,
  KnowledgeCaptureStartSchema,
  KnowledgeOrganizeSchema,
  WebSnapshotSchema,
} from '@werewolf/shared';
import type { Queue } from 'bullmq';
import { AdminTokenGuard } from '../common/guards/admin-token.guard';
import { parseBody } from '../common/parse-body';
import { loadEnv } from '../config/env';
import { embeddingKey, embeddingRuntime } from '../llm/embedding';
import { KnowledgeConflictError } from '../store/knowledge';
import type { CaptureRecord } from '../store/knowledge-imports';
import { requireCandidate } from '../store/knowledge-imports';
import type { GameStores } from '../store/stores';
import { GAME_STORES } from '../store/stores.provider';
import { validateKnowledgeContent, validateKnowledgeSources } from './content-validation';
import { importJobId, KNOWLEDGE_IMPORT_QUEUE, type KnowledgeImportJob } from './import-queue';
import { organizationRuntime, prepareOrganization } from './import-workflow';
import { sourceUrl } from './web-source';
import { KNOWLEDGE_QUEUE, type KnowledgeJob } from './knowledge-queue';
import { enqueueKnowledgeIndex } from './indexing';

async function conflict<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof KnowledgeConflictError) throw new ConflictException(error.message);
    throw error;
  }
}
export function captureView(row: CaptureRecord) {
  const organization = row.state.organization;
  return KnowledgeCaptureSchema.parse({
    ...row,
    ...row.state,
    organization: organization
      ? {
          status: organization.status,
          failure: organization.failure,
          model: organization.input.model,
          boardIds: organization.input.boardIds,
          paragraphIds: organization.input.paragraphIds,
          targetIds: organization.input.targets.map((t) => t.id),
          reason: organization.reason,
          calls: organization.attempts.map(({ callId, status }) => ({ callId, status })),
        }
      : null,
  });
}

@Controller('knowledge/imports')
@UseGuards(AdminTokenGuard)
export class KnowledgeImportController {
  constructor(
    @Inject(GAME_STORES) private readonly stores: GameStores,
    @InjectQueue(KNOWLEDGE_IMPORT_QUEUE) private readonly queue: Queue<KnowledgeImportJob>,
    @InjectQueue(KNOWLEDGE_QUEUE) private readonly indexQueue: Queue<KnowledgeJob>,
  ) {}
  private async require(id: string) {
    const row = await this.stores.knowledgeImports.find(id);
    if (!row) throw new NotFoundException('没有这份采集记录');
    return row;
  }
  private async view(row: CaptureRecord) {
    const result = captureView(row);
    if (row.state.organization?.attempts.at(-1)?.status === 'pending') {
      const job = await this.queue.getJob(importJobId(row.id, 'organize'));
      if (!job || !(await job.isActive()))
        result.organization = {
          ...result.organization!,
          status: 'unknown',
          failure: '上次整理请求结果未知，不能重发，请核查调用记录',
        };
    }
    return result;
  }
  private async enqueue(id: string, operation: KnowledgeImportJob['operation']) {
    const jobId = importJobId(id, operation);
    const job = await this.queue.getJob(jobId);
    if (job && ['active', 'waiting', 'delayed'].includes(await job.getState())) return;
    if (job) await job.remove();
    await this.queue.add(operation, { captureId: id, operation }, { jobId, attempts: 1 });
  }
  @Get()
  async list() {
    return KnowledgeCapturesSchema.parse({
      captures: await Promise.all(
        (await this.stores.knowledgeImports.list()).map((r) => this.view(r)),
      ),
    });
  }
  @Get('model')
  model() {
    return { model: loadEnv().MODEL_DEFAULT_MODEL };
  }

  @Post()
  async start(@Body() body: unknown) {
    const data = parseBody(KnowledgeCaptureStartSchema, body);
    let urls: string[];
    try {
      urls = [...new Set(data.urls.map(sourceUrl))];
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : '链接无效');
    }
    const rows = await conflict(() => this.stores.knowledgeImports.open(data.batchId, urls));
    await Promise.all(
      rows.filter((r) => !r.state.snapshot).map((r) => this.enqueue(r.id, 'capture')),
    );
    return KnowledgeCapturesSchema.parse({ captures: rows.map(captureView) });
  }
  @Post('actions')
  async actions(@Body() body: unknown) {
    const data = parseBody(KnowledgeBulkActionSchema, body);
    const records = new Map((await this.stores.knowledge.list()).map((item) => [item.id, item]));
    const results = [];
    // 每项是独立操作，失败不会撤销已完成项；索引接口本身负责入队幂等。
    for (const item of data.items) {
      let error: string | null = null;
      try {
        const current = records.get(item.id);
        const version = current?.versions.find((v) => v.versionId === item.versionId);
        if (!current || !version) throw new Error('知识版本与条目不匹配');
        if (current.revision !== item.revision)
          throw new KnowledgeConflictError('知识已被修改，请刷新后重新核对');
        if (data.operation === 'index')
          await enqueueKnowledgeIndex(this.stores, this.indexQueue, version);
        else
          await this.stores.knowledge.activate(
            item.id,
            item.revision,
            item.versionId,
            embeddingKey(embeddingRuntime()),
          );
      } catch (failure) {
        error = failure instanceof Error ? failure.message : '操作失败';
      }
      results.push({ id: item.id, versionId: item.versionId, error });
    }
    return KnowledgeBulkResultSchema.parse({ results });
  }
  @Get(':id')
  async read(@Param('id', ParseUUIDPipe) id: string) {
    return this.view(await this.require(id));
  }
  @Get(':id/calls')
  async calls(@Param('id', ParseUUIDPipe) id: string) {
    await this.require(id);
    return this.stores.asked.captureCalls(id);
  }
  @Post(':id/retry')
  async retry(@Param('id', ParseUUIDPipe) id: string) {
    const row = await this.require(id);
    if (!row.state.snapshot) await this.enqueue(id, 'capture');
    return this.view(row);
  }
  @Post(':id/organize')
  async organize(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const selection = parseBody(KnowledgeOrganizeSchema, body);
    const row = await this.require(id);
    const job = await this.queue.getJob(importJobId(id, 'organize'));
    if (job && ['active', 'waiting', 'delayed'].includes(await job.getState()))
      return this.view(row);
    const prepared = await conflict(() =>
      prepareOrganization(this.stores, row, selection, organizationRuntime()),
    );
    if (prepared.state.organization?.status !== 'ready') await this.enqueue(id, 'organize');
    return this.view(prepared);
  }
  @Put(':id/candidates/:candidateId')
  async confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
    @Body() body: unknown,
  ) {
    const { content, expectedRevision } = parseBody(KnowledgeCandidateSaveSchema, body);
    const row = await this.require(id);
    await conflict(async () => requireCandidate(row, candidateId));
    validateKnowledgeContent(content);
    await validateKnowledgeSources(this.stores, content);
    const cited = content.sources.find((s) => s.captureId === id);
    if (
      !cited ||
      cited.url !== row.state.snapshot?.url ||
      !cited.paragraphIds?.length ||
      cited.paragraphIds.some((p) => !row.state.snapshot!.paragraphs.some((s) => s.id === p))
    )
      throw new BadRequestException('请保留本次采集的网页链接、快照和有效段落引用');
    return this.view(
      await conflict(() =>
        this.stores.knowledgeImports.confirm(id, candidateId, content, expectedRevision),
      ),
    );
  }
  @Post(':id/candidates/:candidateId/discard')
  async discard(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
  ) {
    await this.require(id);
    return this.view(await conflict(() => this.stores.knowledgeImports.discard(id, candidateId)));
  }
}

@Controller('knowledge/sources')
export class KnowledgeSourceController {
  constructor(@Inject(GAME_STORES) private readonly stores: GameStores) {}
  @Get(':id')
  async read(@Param('id', ParseUUIDPipe) id: string) {
    const row = await this.stores.knowledgeImports.find(id);
    if (!row?.state.snapshot) throw new NotFoundException('没有这份网页快照');
    return WebSnapshotSchema.parse(row.state.snapshot);
  }
}
