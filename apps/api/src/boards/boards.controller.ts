import { Controller, Get } from '@nestjs/common';
import { BoardListResponseSchema, type BoardListResponse } from '@werewolf/shared';
import { ALL_BOARDS, BOARD_IDS, handOf } from './boards';

@Controller('boards')
export class BoardsController {
  /** 建局时能选的板子。名字与人数从板子配置现读，前端不另存一份。 */
  @Get()
  list(): BoardListResponse {
    return BoardListResponseSchema.parse({
      boards: BOARD_IDS.map((id) => ({
        id,
        name: ALL_BOARDS[id].name,
        playerCount: handOf(ALL_BOARDS[id]).length,
        hasSheriff: ALL_BOARDS[id].hasSheriff,
      })),
    });
  }
}
