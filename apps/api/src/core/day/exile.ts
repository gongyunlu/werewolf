import { DEATH_CAUSES } from '@werewolf/shared';
import type { ActionProvider } from '../actions';
import { pkSpeechOrder } from '../speech-order';
import type { GameState } from '../state';
import { collectVotes, tallyVotes, type VoteRound } from '../vote';
import { announceDay } from './announce';
import { speakInOrder, type Speech } from './speech';

/** 放逐结果。exiledId 为 null 表示本轮无人出局。 */
export interface ExileResult {
  state: GameState;
  exiledId: string | null;
  speeches: Speech[];
}

/**
 * 放逐环节：全员投票 → 平票 PK → 放逐执行 → 警徽处理。
 *
 * speechOrder 是当天实际走过的发言顺序，PK 从它筛出平票者倒过来，不重算（见 speech-order.ts）。
 * 两轮都允许弃票和自投；平票要再 PK 一轮，只有没上 PK 台的存活玩家能投，且只能投台上的人。
 */
export async function runExile(
  state: GameState,
  actions: ActionProvider,
  speechOrder: readonly number[],
): Promise<ExileResult> {
  const alive = state.players.filter((player) => player.isAlive);
  const speeches: Speech[] = [];

  const round: VoteRound = {
    voters: alive.map((player) => player.id),
    candidates: alive.map((player) => player.id),
    weightedVoterId: state.sheriffId,
  };
  const ballot = await collectVotes(round, (voterId) =>
    actions.vote('exile', voterId, round.candidates),
  );
  const outcome = tallyVotes(round, ballot);

  if (outcome.kind === 'elected') return execute(state, outcome.winnerId, speeches);
  if (outcome.kind === 'none') return { state, exiledId: null, speeches };

  const tied = alive.filter((player) => outcome.tiedIds.includes(player.id));
  const tiedSeatNos = new Set(tied.map((player) => player.seatNo));
  const pkOrder = pkSpeechOrder(speechOrder, tiedSeatNos);
  speeches.push(...(await speakInOrder('exile_pk', pkOrder, state.players, actions)));

  // 只有 PK 台上的人可以被投，台上的人自己没票。
  const pkRound: VoteRound = {
    voters: alive.filter((player) => !tiedSeatNos.has(player.seatNo)).map((player) => player.id),
    candidates: tied.map((player) => player.id),
    weightedVoterId: state.sheriffId,
  };
  const pkBallot = await collectVotes(pkRound, (voterId) =>
    actions.vote('exile_pk', voterId, pkRound.candidates),
  );
  const pkOutcome = tallyVotes(pkRound, pkBallot);

  // 再平票或又全员弃票：本轮无人出局。
  if (pkOutcome.kind !== 'elected') return { state, exiledId: null, speeches };

  return execute(state, pkOutcome.winnerId, speeches);
}

/**
 * 把放逐落到状态上。警徽不在这儿动：被放逐者的死后技能排在前面，
 * 他带走的、开枪打死的那批人得先进候选名单，见 loop.settleExile。
 */
function execute(state: GameState, exiledId: string, speeches: Speech[]): ExileResult {
  const exiled: GameState = announceDay(state, [
    { playerId: exiledId, cause: DEATH_CAUSES.EXECUTION },
  ]).state;

  return { state: exiled, exiledId, speeches };
}
