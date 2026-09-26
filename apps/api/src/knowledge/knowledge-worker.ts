import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { GameStores } from '../store/stores';
import { GAME_STORES } from '../store/stores.provider';
import { KNOWLEDGE_QUEUE, type KnowledgeJob } from './knowledge-queue';
import { indexKnowledge } from './indexing';

@Processor(KNOWLEDGE_QUEUE, { concurrency: 1 })
export class KnowledgeWorker extends WorkerHost {
  constructor(@Inject(GAME_STORES) private readonly stores: GameStores) {
    super();
  }
  async process(job: Job<KnowledgeJob>) {
    await indexKnowledge(this.stores, job.data.versionId);
  }
}
