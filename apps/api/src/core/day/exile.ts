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
 * speechOrder 是当天白天已经走过的发言顺序，平票 PK 的发言顺序就是把它筛出平票者
 * 再倒过来。之所以要传进来而不是在这里重算：PK 的「相反」是相对当天实际发生的那轮
 * 发言而言的，重算一遍会在警长临时改方向时和实际不符。
 *
 * 两轮投票都允许弃票、允许自投；平票 PK 只有非平票的存活玩家能投，且只能投给
 * PK 台上的其中一位。两轮里警长的票都按 1.5 计。
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
  // 全员弃票，本轮无人出局。
  if (outcome.kind === 'none') return { state, exiledId: null, speeches };

  // 平票：平票者按与当天发言相反的顺序再发言一轮。
  const tied = alive.filter((player) => outcome.tiedIds.includes(player.id));
  const tiedSeatNos = new Set(tied.map((player) => player.seatNo));
  const pkOrder = pkSpeechOrder(speechOrder, tiedSeatNos);
  speeches.push(...(await speakInOrder('exile_pk', pkOrder, state.players, actions)));

  // 只有在 PK 台上的人可以被投。
  const pkRound: VoteRound = {
    voters: alive.filter((player) => !tiedSeatNos.has(player.seatNo)).map((player) => player.id),
    candidates: tied.map((player) => player.id),
    weightedVoterId: state.sheriffId,
  };
  const pkBallot = await collectVotes(pkRound, (voterId) =>
    actions.vote('exile_pk', voterId, pkRound.candidates),
  );
  const pkOutcome = tallyVotes(pkRound, pkBallot);

  // 再平票与全员弃票是两回事，但结局一样：本轮无人出局，直接进入黑夜。
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
