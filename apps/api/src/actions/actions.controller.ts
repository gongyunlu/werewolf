import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import {
  ActionLogResponseSchema,
  ActionSummaryResponseSchema,
  ActionDetailResponseSchema,
  type ActionLogEntry,
  type ActionLogResponse,
} from '@werewolf/shared';
import { ActionSnapshotFields, type StoredAction } from '../store/actions';
import { nodeNameOf, parsePhaseInstanceId } from '../core/identity';
import { GAME_STORES } from '../store/stores.provider';
import type { GameStores } from '../store/stores';
import { actionSteps } from '../turn/graph';

/** 一行记录摊成前端要的那一片；快照里全是人话，不用再连表。 */
function logEntry(row: StoredAction): ActionLogEntry {
  const snapshot = ActionSnapshotFields.parse((row.outcome as { snapshot: unknown }).snapshot);

  return {
    actionKey: row.actionKey,
    actionType: row.actionType,
    day: snapshot.context.day,
    seatNo: snapshot.context.actor.seatNo,
    role: snapshot.context.actor.role,
    task: snapshot.context.task,
    decision: snapshot.decision,
    reasoning: snapshot.reasoning,
    ...(snapshot.thinkingMs != null ? { thinkingMs: snapshot.thinkingMs } : {}),
  };
}

@Controller('games')
export class ActionsController {
  constructor(@Inject(GAME_STORES) private readonly stores: GameStores) {}

  @Get(':gameId/actions/summaries')
  async summaries(@Param('gameId') gameId: string) {
    const [rows, events] = await Promise.all([
      this.stores.actions.summaries(gameId),
      this.stores.events.positions(gameId),
    ]);
    const eventSeqs = new Map(events.map((event) => [event.eventKey, event.seq]));
    return ActionSummaryResponseSchema.parse({
      actions: rows
        .filter((row) => row.status === 'done')
        .map((row) => {
          const { reasoning: _reasoning, ...entry } = logEntry(row);
          const phase = parsePhaseInstanceId(row.phaseInstanceId);
          if (!phase) throw new Error(`行动的阶段标识无效：${row.phaseInstanceId}`);
          const node = nodeNameOf(phase);
          return {
            ...entry,
            ledgerSeq: row.ledgerSeq,
            hasReasoning: row.hasReasoning,
            phase: node === 'dawn' ? 'day' : node,
            eventSeq: eventSeqs.get(row.actionKey) ?? null,
          };
        }),
      pending: rows
        .filter((row) => row.status === 'running')
        .map(({ actionKey, actionType, actorId }) => ({
          actionKey,
          actionType,
          actorId,
        })),
    });
  }

  @Get(':gameId/actions/detail')
  async detail(@Param('gameId') gameId: string, @Query('actionKey') key: string) {
    const row = await this.stores.actions.find(key);
    if (!row || row.gameId !== gameId) throw new NotFoundException('没有这条行动记录');
    return ActionDetailResponseSchema.parse({
      reasoning: row.status === 'done' ? logEntry(row).reasoning : null,
      steps: await actionSteps(this.stores.checkpoints, key),
    });
  }

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
