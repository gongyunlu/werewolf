import { ACTION_TYPES, DayEndJudgmentSchema, type PreviousJudgment } from '@werewolf/shared';
import type { GameState } from '../core/state';
import { ActionSnapshotFields, type StoredAction } from '../store/actions';

export interface PersonalJudgment extends PreviousJudgment {
  gameId: string;
  actorId: string;
}

export function savedJudgment(row: StoredAction): PersonalJudgment | null {
  if (row.actionType !== ACTION_TYPES.DAY_END_JUDGMENT || row.status !== 'done') return null;
  const snapshot = ActionSnapshotFields.parse((row.outcome as { snapshot: unknown }).snapshot);
  return {
    ...DayEndJudgmentSchema.parse(snapshot.decision),
    gameId: row.gameId,
    actorId: row.actorId,
    actionKey: row.actionKey,
    day: snapshot.context.day,
    ledgerSeq: row.ledgerSeq,
  };
}

/** 同一游戏日的行动都发生在日终之前，恢复时不能提前读到当日日终或更晚的判断。 */
export function latestJudgment(
  judgments: Iterable<PersonalJudgment>,
  state: GameState,
  actorId: string,
  ledgerSeq: number,
): PreviousJudgment | undefined {
  let latest: PersonalJudgment | undefined;
  for (const item of judgments) {
    if (
      item.gameId === state.gameId &&
      item.actorId === actorId &&
      item.day < state.day &&
      item.ledgerSeq <= ledgerSeq &&
      (!latest || item.day > latest.day)
    )
      latest = item;
  }
  if (!latest) return undefined;
  const { gameId: _gameId, actorId: _actorId, ...previous } = latest;
  return previous;
}
