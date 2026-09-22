import { Controller, Get, Inject, Param } from '@nestjs/common';
import {
  ActionLogResponseSchema,
  type ActionLogEntry,
  type ActionLogResponse,
} from '@werewolf/shared';
import { z } from 'zod';
import type { StoredAction } from '../store/actions';
import { GAME_STORES } from '../store/stores.provider';
import type { GameStores } from '../store/stores';

/**
 * 快照里这份列表用得着的那几项。
 * 单独立一份而不是拿快照的类型去断言：库里的记录是更早的版本写下的，`reasoning` 那一项
 * 那会儿还没有，断言成 string 只会读出一个 undefined 来。
 */
const SnapshotFields = z.object({
  context: z.object({
    task: z.string(),
    actor: z.object({ seatNo: z.number(), role: z.string() }),
    day: z.number(),
  }),
  decision: z.unknown(),
  reasoning: z.string().nullable().default(null),
});

/** 一行记录摊成前端要的那一片；快照里全是人话，不用再连表。 */
function logEntry(row: StoredAction): ActionLogEntry {
  const snapshot = SnapshotFields.parse((row.outcome as { snapshot: unknown }).snapshot);

  return {
    actionKey: row.actionKey,
    actionType: row.actionType,
    day: snapshot.context.day,
    seatNo: snapshot.context.actor.seatNo,
    role: snapshot.context.actor.role,
    task: snapshot.context.task,
    decision: snapshot.decision,
    reasoning: snapshot.reasoning,
  };
}

@Controller('games')
export class ActionsController {
  constructor(@Inject(GAME_STORES) private readonly stores: GameStores) {}

  /**
   * 这一局每一问留下的决定与它的理由，按问的先后。
   * 只读，也只出答完的那些：还没答完的行没有结果，重走到那一问会整个重跑一遍。
   */
  @Get(':gameId/actions')
  async list(@Param('gameId') gameId: string): Promise<ActionLogResponse> {
    const rows = await this.stores.actions.list(gameId);

    // 走一遍共享契约，别让实现悄悄偏离约定
    return ActionLogResponseSchema.parse({
      actions: rows.filter((row) => row.status === 'done').map(logEntry),
    });
  }
}
