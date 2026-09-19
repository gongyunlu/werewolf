import { DEATH_CAUSES } from '@werewolf/shared';
import type { ActionProvider } from '../actions';
import { pkSpeechOrder } from '../speech-order';
import type { GameState } from '../state';
import { collectVotes, tallyVotes, type VoteRound } from '../vote';
import { handOverBadge } from './badge';
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

  if (outcome.kind === 'elected') return execute(state, actions, outcome.winnerId, speeches);
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

  return execute(state, actions, pkOutcome.winnerId, speeches);
}

/** 把放逐落到状态上，警长被放逐时接着处理警徽。 */
async function execute(
  state: GameState,
  actions: ActionProvider,
  exiledId: string,
  speeches: Speech[],
): Promise<ExileResult> {
  const exiled: GameState = {
    ...state,
    players: state.players.map((player) =>
      player.id === exiledId
        ? { ...player, isAlive: false, deathDay: state.day, deathCause: DEATH_CAUSES.EXECUTION }
        : player,
    ),
  };

  return {
    state: exiled.sheriffId === exiledId ? await handOverBadge(exiled, actions, exiledId) : exiled,
    exiledId,
    speeches,
  };
}
