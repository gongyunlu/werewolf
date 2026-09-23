import { Module } from '@nestjs/common';
import { StoresModule } from '../store/stores.module';
import { ActionsController } from './actions.controller';

@Module({
  imports: [StoresModule],
  controllers: [ActionsController],
})
export class ActionsModule {}
