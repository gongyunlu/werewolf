import type { ActionProvider } from '../actions';
import { alivePlayers, type GameState, type PlayerState } from '../state';

/** 这一夜用掉的解药与毒药落点，没用的为 null。 */
export interface WitchAction {
  antidoteTargetId: string | null;
  poisonTargetId: string | null;
}

/**
 * 女巫这一夜的决定：一次睁眼把两种药都定下来，只问一次、只取一个答案。
 *
 * 刀口传的是她此刻看得到的那个，null 只表示看不到（空刀或已用掉解药，口径同 visibility.ts）。
 * 指向她自己时也照传：不能自救是解药的规则，不是她看到的事实，抹掉就分不清空刀和自己被刀。
 * 真选了自救直接抛错；毒药不受解药历史限制，救过人照样能毒。
 */
export async function decideWitch(
  witch: PlayerState | null,
  state: GameState,
  killTargetId: string | null,
  actions: ActionProvider,
): Promise<WitchAction> {
  const nothing: WitchAction = { antidoteTargetId: null, poisonTargetId: null };
  if (witch === null) return nothing;

  const seenKillTargetId = !witch.hasAntidoteUsed ? killTargetId : null;
  const canSave = seenKillTargetId !== null && seenKillTargetId !== witch.id;

  const poisonCandidates = witch.hasPoisonUsed
    ? []
    : alivePlayers(state)
        .filter((player) => player.id !== witch.id)
        .map((player) => player.id);

  // 两种药都用不上，不用叫醒她。
  if (!canSave && poisonCandidates.length === 0) return nothing;

  const decision = await actions.witchDecision(witch.id, seenKillTargetId, poisonCandidates);

  if (decision.kind === 'antidote') {
    if (!canSave) throw new Error(`${witch.id} 今夜不能自救，或解药没有可救的目标`);
    return { antidoteTargetId: seenKillTargetId, poisonTargetId: null };
  }

  if (decision.kind === 'poison') {
    if (!poisonCandidates.includes(decision.targetId)) {
      throw new Error(`毒药只能落在其他存活玩家身上：${decision.targetId}`);
    }
    return { antidoteTargetId: null, poisonTargetId: decision.targetId };
  }

  return nothing;
}
