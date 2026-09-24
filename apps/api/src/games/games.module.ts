import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { StoresModule } from '../store/stores.module';
import { GamesController } from './games.controller';
import { StatisticsController } from './statistics.controller';

@Module({
  imports: [StoresModule, QueueModule],
  controllers: [GamesController, StatisticsController],
})
export class GamesModule {}
