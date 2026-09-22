import type { ActionProvider } from '../actions';
import { campaignSpeechOrder, pkSpeechOrder } from '../speech-order';
import type { GameState, PlayerState } from '../state';
import { collectVotes, tallyVotes, type VoteRound } from '../vote';
import { runBlastWindow } from './self-destruct';
import { speakInOrder, type Speech } from './speech';

/** 竞选结果；speeches 含警上发言与 PK 两轮。 */
export interface SheriffElectionResult {
  /** 选出警长之后的状态；警徽流失、竞选被打断时 sheriffId 仍是 null。 */
  state: GameState;
  /** 竞选被狼人自爆打断，当天剩下的全跳过。 */
  aborted: boolean;
  speeches: Speech[];
}

/**
 * 警长竞选：上警报名 → 自爆窗口 → 警上发言 → 统一退水 → 警下投票 → 平票 PK。
 *
 * 第一天被打断过的竞选挂在 sheriffElectionSuspended 上，第二天从退水表态接着走，
 * 报名与警上发言都跳过；续轮再被打断就是双爆，警徽直接流失。看挂起标记本身、不看天数：
 * 续轮落在第二天还是更晚都成立，只看天数会把续轮误当成已经选完了。
 *
 * 上警和退水都按座位号逐个问，顺序不影响结果，只为对局可重放；没人上警、警上全退水、
 * 全员上警、警下全弃票这四种都没有警长；只剩一名参选者直接当选，不投票。
 */
export async function runSheriffElection(
  state: GameState,
  actions: ActionProvider,
  minute: number,
): Promise<SheriffElectionResult> {
  const suspended = state.sheriffElectionSuspended;
  if (!state.hasSheriff || (suspended === null && state.day !== 1)) {
    return { state, aborted: false, speeches: [] };
  }

  // 续轮走到这里竞选就重新开张了，挂起标记先清掉：下面哪条路都不该再挂一次。
  const base: GameState = suspended === null ? state : { ...state, sheriffElectionSuspended: null };
  const alive = base.players.filter((player) => player.isAlive);
  const speeches: Speech[] = [];
  const idle = (from: GameState): SheriffElectionResult => ({
    state: { ...from, sheriffElectionSettled: true },
    aborted: false,
    speeches,
  });
  /** 竞选被自爆打断。ids 是挂起下来待续的上警名单，为续轮或无人上警时留空。 */
  const suspend = (from: GameState, ids: readonly string[]): SheriffElectionResult => ({
    state: {
      ...from,
      sheriffElectionSuspended: ids.length > 0 ? ids : null,
      // 名单为空有两条路：续轮再爆（警徽作废），以及无人上警时首爆（本来就没人可续）。
      // 两种都不该再有警长，跟走完了一样算落定。
      sheriffElectionSettled: ids.length === 0,
    },
    aborted: true,
    speeches,
  });

  const campaign: PlayerState[] =
    suspended === null
      ? await askCandidacy(alive, actions)
      : alive.filter((player) => suspended.includes(player.id));

  // 续轮没走过警上发言，PK 顺序只能从这批人按单顺双逆排出来的次序里取。
  const campaignOrder = campaignSpeechOrder(
    campaign.map((player) => player.seatNo),
    minute,
  );

  if (suspended === null) {
    const blast = await runBlastWindow(base, 'campaign', actions);
    // 首爆挂起竞选：警徽先留着，第二天从退水表态接着走。
    if (blast.blasted)
      return suspend(
        blast.state,
        campaign.map((player) => player.id),
      );
    if (campaign.length === 0) return idle(base);

    speeches.push(...(await speakInOrder('campaign', campaignOrder, base.players, actions)));
  } else {
    const blast = await runBlastWindow(base, 'campaign_resume', actions);
    // 二爆吞掉警徽：竞选到此作废，本局没有警长。
    if (blast.blasted) return suspend(blast.state, []);
  }

  // 全发完言再统一退水；退过水的人不能被选，也没有票。
  const withdrawn = new Set<string>();
  for (const player of campaign) {
    if (await actions.withdraw(player.id)) withdrawn.add(player.id);
  }

  const candidates = campaign.filter((player) => !withdrawn.has(player.id));
  if (candidates.length === 0) return idle(base);
  if (candidates.length === 1) return elect(base, speeches, candidates[0].id);

  // 投票的是警下玩家：存活玩家去掉上过警的，退过水的也算上过警。
  const campaignIds = new Set(campaign.map((player) => player.id));
  const voters = alive.filter((player) => !campaignIds.has(player.id));
  if (voters.length === 0) return idle(base);

  const round: VoteRound = {
    voters: voters.map((player) => player.id),
    candidates: candidates.map((player) => player.id),
    weightedVoterId: null,
  };
  const ballot = await collectVotes(round, (voterId) =>
    actions.vote('campaign', voterId, round.candidates),
  );
  const outcome = tallyVotes(round, ballot);

  if (outcome.kind === 'elected') return elect(base, speeches, outcome.winnerId);
  if (outcome.kind === 'none') return idle(base);

  // 平票：平票者按相反顺序再发一轮言，同一批警下玩家再投一次。
  const tied = candidates.filter((player) => outcome.tiedIds.includes(player.id));
  const tiedSeatNos = new Set(tied.map((player) => player.seatNo));
  const pkOrder = pkSpeechOrder(campaignOrder, tiedSeatNos);
  speeches.push(...(await speakInOrder('campaign_pk', pkOrder, base.players, actions)));

  const pkRound: VoteRound = { ...round, candidates: tied.map((player) => player.id) };
  const pkBallot = await collectVotes(pkRound, (voterId) =>
    actions.vote('campaign_pk', voterId, pkRound.candidates),
  );
  const pkOutcome = tallyVotes(pkRound, pkBallot);

  if (pkOutcome.kind === 'elected') return elect(base, speeches, pkOutcome.winnerId);

  // 再平票：警徽流失，本局没有警长。
  return idle(base);
}

/** 按座位号逐个问是否上警，顺序只为可重放，不影响结果。 */
async function askCandidacy(
  alive: readonly PlayerState[],
  actions: ActionProvider,
): Promise<PlayerState[]> {
  const campaign: PlayerState[] = [];
  for (const player of alive) {
    if (await actions.runForSheriff(player.id)) campaign.push(player);
  }

  return campaign;
}

function elect(state: GameState, speeches: Speech[], winnerId: string): SheriffElectionResult {
  return {
    state: { ...state, sheriffId: winnerId, sheriffElectionSettled: true },
    aborted: false,
    speeches,
  };
}
