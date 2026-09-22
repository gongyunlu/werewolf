import { Module } from '@nestjs/common';
import { gameStoresProvider } from '../store/stores.provider';
import { ActionsController } from './actions.controller';

@Module({
  controllers: [ActionsController],
  providers: [gameStoresProvider],
})
export class ActionsModule {}
