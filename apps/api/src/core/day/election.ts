import type { ActionProvider } from '../actions';
import { campaignSpeechOrder, pkSpeechOrder } from '../speech-order';
import type { GameState, PlayerState } from '../state';
import { collectVotes, tallyVotes, type VoteRound } from '../vote';
import { speakInOrder, type Speech } from './speech';

/** 竞选结果；speeches 含警上发言与 PK 两轮。 */
export interface SheriffElectionResult {
  /** 选出警长之后的状态；警徽流失时 sheriffId 仍为 null。 */
  state: GameState;
  speeches: Speech[];
}

/**
 * 警长竞选：上警报名 → 警上发言 → 统一退水 → 警下投票 → 平票 PK。
 *
 * 上警和退水都按座位号逐个问，顺序不影响结果，只为对局可重放；没人上警、警上全退水、
 * 全员上警、警下全弃票这四种都没有警长；只剩一名参选者直接当选，不投票。
 */
export async function runSheriffElection(
  state: GameState,
  actions: ActionProvider,
  minute: number,
): Promise<SheriffElectionResult> {
  // 警长只在首日选，之后撕了或没选出来都不补选，所以看天数而不是 sheriffId。
  if (!state.hasSheriff || state.day !== 1) return { state, speeches: [] };

  const alive = state.players.filter((player) => player.isAlive);
  const speeches: Speech[] = [];
  const elect = (winnerId: string): SheriffElectionResult => ({
    state: { ...state, sheriffId: winnerId },
    speeches,
  });

  const campaign: PlayerState[] = [];
  for (const player of alive) {
    if (await actions.runForSheriff(player.id)) campaign.push(player);
  }
  if (campaign.length === 0) return { state, speeches };

  const campaignOrder = campaignSpeechOrder(
    campaign.map((player) => player.seatNo),
    minute,
  );
  speeches.push(...(await speakInOrder('campaign', campaignOrder, state.players, actions)));

  // 全发完言再统一退水；退过水的人不能被选，也没有票。
  const withdrawn = new Set<string>();
  for (const player of campaign) {
    if (await actions.withdraw(player.id)) withdrawn.add(player.id);
  }

  const candidates = campaign.filter((player) => !withdrawn.has(player.id));
  if (candidates.length === 0) return { state, speeches };
  if (candidates.length === 1) return elect(candidates[0].id);

  // 投票的是警下玩家：存活玩家去掉上过警的，退过水的也算上过警。
  const campaignIds = new Set(campaign.map((player) => player.id));
  const voters = alive.filter((player) => !campaignIds.has(player.id));
  if (voters.length === 0) return { state, speeches };

  const round: VoteRound = {
    voters: voters.map((player) => player.id),
    candidates: candidates.map((player) => player.id),
    weightedVoterId: null,
  };
  const ballot = await collectVotes(round, (voterId) =>
    actions.vote('campaign', voterId, round.candidates),
  );
  const outcome = tallyVotes(round, ballot);

  if (outcome.kind === 'elected') return elect(outcome.winnerId);
  if (outcome.kind === 'none') return { state, speeches };

  // 平票：平票者按相反顺序再发一轮言，同一批警下玩家再投一次。
  const tied = candidates.filter((player) => outcome.tiedIds.includes(player.id));
  const tiedSeatNos = new Set(tied.map((player) => player.seatNo));
  const pkOrder = pkSpeechOrder(campaignOrder, tiedSeatNos);
  speeches.push(...(await speakInOrder('campaign_pk', pkOrder, state.players, actions)));

  const pkRound: VoteRound = { ...round, candidates: tied.map((player) => player.id) };
  const pkBallot = await collectVotes(pkRound, (voterId) =>
    actions.vote('campaign_pk', voterId, pkRound.candidates),
  );
  const pkOutcome = tallyVotes(pkRound, pkBallot);

  if (pkOutcome.kind === 'elected') return elect(pkOutcome.winnerId);

  // 再平票：警徽流失，本局没有警长。
  return { state, speeches };
}
