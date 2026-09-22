import { DEATH_CAUSES } from '@werewolf/shared';
import type { ActionProvider, BallotTurn } from '../actions';
import { pkSpeechOrder } from '../speech-order';
import type { GameState } from '../state';
import { collectVotes, tallyVotes, type VoteCast, type VoteOutcome, type VoteRound } from '../vote';
import { announceDay } from './announce';
import { speakInOrder, type Speech } from './speech';

/** 一轮投票收齐之后的样子：谁投了谁，以及计票结果。 */
export interface ExileBallot {
  round: BallotTurn;
  casts: readonly VoteCast[];
  outcome: VoteOutcome;
}

/** 放逐结果。exiledId 为 null 表示本轮无人出局。 */
export interface ExileResult {
  state: GameState;
  exiledId: string | null;
  speeches: Speech[];
  /** 这一天投过的每一轮，按先后。收齐才算得出来，只有 Core 拿得到。 */
  ballots: readonly ExileBallot[];
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
  const first: ExileBallot = { round: 'exile', casts: ballot, outcome };

  if (outcome.kind === 'elected') return execute(state, outcome.winnerId, speeches, [first]);
  if (outcome.kind === 'none') return { state, exiledId: null, speeches, ballots: [first] };

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
  const second: ExileBallot = { round: 'exile_pk', casts: pkBallot, outcome: pkOutcome };

  // 再平票或又全员弃票：本轮无人出局。
  if (pkOutcome.kind !== 'elected') {
    return { state, exiledId: null, speeches, ballots: [first, second] };
  }

  return execute(state, pkOutcome.winnerId, speeches, [first, second]);
}

/**
 * 把放逐落到状态上。警徽不在这儿动：被放逐者的死后技能排在前面，
 * 他带走的、开枪打死的那批人得先进候选名单，见 loop.settleExile。
 */
function execute(
  state: GameState,
  exiledId: string,
  speeches: Speech[],
  ballots: readonly ExileBallot[],
): ExileResult {
  const exiled: GameState = announceDay(state, [
    { playerId: exiledId, cause: DEATH_CAUSES.EXECUTION },
  ]).state;

  return { state: exiled, exiledId, speeches, ballots };
}
