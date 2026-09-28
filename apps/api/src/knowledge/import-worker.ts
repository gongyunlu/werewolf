import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { GameStores } from '../store/stores';
import { GAME_STORES } from '../store/stores.provider';
import { KNOWLEDGE_IMPORT_QUEUE, type KnowledgeImportJob } from './import-queue';
import { captureKnowledgePage, organizeKnowledgePage } from './import-workflow';

@Processor(KNOWLEDGE_IMPORT_QUEUE, { concurrency: 1 })
export class KnowledgeImportWorker extends WorkerHost {
  constructor(@Inject(GAME_STORES) private readonly stores: GameStores) {
    super();
  }
  async process(job: Job<KnowledgeImportJob>) {
    if (job.data.operation === 'capture')
      await captureKnowledgePage(this.stores, job.data.captureId);
    else await organizeKnowledgePage(this.stores, job.data.captureId);
  }
}
