import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { StoresModule } from '../store/stores.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeImportController, KnowledgeSourceController } from './import.controller';

@Module({
  imports: [StoresModule, QueueModule],
  controllers: [KnowledgeImportController, KnowledgeSourceController, KnowledgeController],
})
export class KnowledgeModule {}
