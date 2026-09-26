import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { GameStores } from '../store/stores';
import { GAME_STORES } from '../store/stores.provider';
import { EXPERIENCE_QUEUE, type ExperienceJob } from './experience-queue';
import { runExperience } from './workflow';
import { indexExperience } from './indexing';

@Processor(EXPERIENCE_QUEUE, { concurrency: 1 })
export class ExperienceWorker extends WorkerHost {
  constructor(@Inject(GAME_STORES) private readonly stores: GameStores) {
    super();
  }
  async process(job: Job<ExperienceJob>) {
    await runExperience(this.stores, job.data.generationId);
    await indexExperience(this.stores, job.data.generationId);
  }
}
