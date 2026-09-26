import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { StoresModule } from '../store/stores.module';
import { KnowledgeController } from './knowledge.controller';

@Module({ imports: [StoresModule, QueueModule], controllers: [KnowledgeController] })
export class KnowledgeModule {}
