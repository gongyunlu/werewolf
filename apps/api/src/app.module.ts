import { Module } from '@nestjs/common';
import { ActionsModule } from './actions/actions.module';
import { AgentsModule } from './agents/agents.module';
import { BoardsModule } from './boards/boards.module';
import { GamesModule } from './games/games.module';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
import { TelemetryModule } from './llm/telemetry.module';

@Module({
  imports: [
    TelemetryModule,
    HealthModule,
    ActionsModule,
    BoardsModule,
    GamesModule,
    AgentsModule,
    QueueModule,
  ],
})
export class AppModule {}
