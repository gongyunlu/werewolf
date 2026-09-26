import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { StoresModule } from '../store/stores.module';
import { ExperienceController } from './experience.controller';

@Module({ imports: [StoresModule, QueueModule], controllers: [ExperienceController] })
export class ExperienceModule {}
