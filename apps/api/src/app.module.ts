import { Module } from '@nestjs/common';
import { ActionsModule } from './actions/actions.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [HealthModule, ActionsModule],
})
export class AppModule {}
