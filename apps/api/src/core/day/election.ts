import type { ActionProvider } from '../actions';
import { campaignSpeechOrder, pkSpeechOrder } from '../speech-order';
import type { GameState, PlayerState } from '../state';
import { collectVotes, tallyVotes, type VoteRound } from '../vote';
import { speakInOrder, type Speech } from './speech';

/** 竞选结果。speeches 按实际发言顺序排列，涵盖警上发言与 PK 发言两轮。 */
export interface SheriffElectionResult {
  /** 选出警长之后的状态；警徽流失时 sheriffId 仍为 null。 */
  state: GameState;
  speeches: Speech[];
}

/**
 * 警长竞选：上警报名 → 警上发言 → 统一退水 → 警下投票 → 平票 PK。
 *
 * 上警与退水都按座位号顺序逐个问，问的顺序不影响结果，只让脚本答案可预测。
 *
 * minute 是当前时间的分钟数，用来算警上发言顺序；时钟从外部传入，引擎不自己看表。
 *
 * 四种情况直接没有警长：没人上警、警上全部退水、全员上警（没人有投票权）、
 * 警下全员弃票。
 * 只剩一名参选者时他直接当选，跳过投票——投票者只有一票可投的选举没有意义。
 */
export async function runSheriffElection(
  state: GameState,
  actions: ActionProvider,
  minute: number,
): Promise<SheriffElectionResult> {
  // 警长只在首日选出。警徽被撕掉或首日没选出都不重新竞选，所以判据是天数而不是
  // sheriffId 是否为空。
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

  // 警上发言：起点与方向按「单顺双逆」落在上警的这批人身上。
  const campaignOrder = campaignSpeechOrder(
    campaign.map((player) => player.seatNo),
    minute,
  );
  speeches.push(...(await speakInOrder('campaign', campaignOrder, state.players, actions)));

  // 全部警上发言结束后统一退水；退水者既不能被选，也不能投票。
  const withdrawn = new Set<string>();
  for (const player of campaign) {
    if (await actions.withdraw(player.id)) withdrawn.add(player.id);
  }

  const candidates = campaign.filter((player) => !withdrawn.has(player.id));
  if (candidates.length === 0) return { state, speeches };
  if (candidates.length === 1) return elect(candidates[0].id);

  // 投票者是警下玩家：存活玩家去掉上警名单，退水者也算上警过，同样没有投票权。
  const campaignIds = new Set(campaign.map((player) => player.id));
  const voters = alive.filter((player) => !campaignIds.has(player.id));
  if (voters.length === 0) return { state, speeches };

  // 竞选阶段还没有警长，没有人加权。
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
  // 警下全员弃票：没有人被选出来，也没有平票可打，本局没有警长。
  if (outcome.kind === 'none') return { state, speeches };

  // 平票：平票者按与上一轮相反的发言顺序再发言一轮，然后由同一批警下玩家再投一次。
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

  // 再平票与全员弃票是两回事，结局一样：警徽流失，本局没有警长。
  return { state, speeches };
}
