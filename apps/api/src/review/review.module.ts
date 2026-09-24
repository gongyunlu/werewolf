import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { StoresModule } from '../store/stores.module';
import { ReviewController } from './review.controller';

@Module({ imports: [StoresModule, QueueModule], controllers: [ReviewController] })
export class ReviewModule {}
