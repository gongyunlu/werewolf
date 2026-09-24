import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import type { GameStores } from '../store/stores';
import { GAME_STORES } from '../store/stores.provider';
import { gameStatistics } from './statistics';

const StatisticsQuery = z
  .object({
    actionKey: z.string().min(1).max(200).optional(),
    summaryKey: z.string().min(1).max(200).optional(),
    after: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()
  .refine((value) => !(value.actionKey && value.summaryKey), '行动与摘要筛选不能同时使用');

@Controller('games')
export class StatisticsController {
  constructor(@Inject(GAME_STORES) private readonly stores: GameStores) {}

  @Get(':gameId/statistics')
  async read(@Param('gameId') gameId: string, @Query() input: unknown) {
    const parsed = StatisticsQuery.safeParse(input);
    if (!parsed.success) throw new BadRequestException('统计查询参数不合法');
    const data = await this.stores.observations.read(gameId);
    if (!data) throw new NotFoundException(`没有这一局：${gameId}`);
    const query = parsed.data;
    if (query.actionKey && !data.actions.some((row) => row.actionKey === query.actionKey)) {
      throw new NotFoundException('本局没有这次行动');
    }
    if (query.summaryKey && !data.calls.some((row) => row.summaryKey === query.summaryKey)) {
      throw new NotFoundException('本局没有这次摘要');
    }
    if (
      query.after !== undefined &&
      !data.calls.some(
        (row) =>
          row.id === query.after &&
          (!query.actionKey || row.actionKey === query.actionKey) &&
          (!query.summaryKey || row.summaryKey === query.summaryKey),
      )
    ) {
      throw new BadRequestException('游标不属于本次查询');
    }
    return gameStatistics(data, query);
  }
}
