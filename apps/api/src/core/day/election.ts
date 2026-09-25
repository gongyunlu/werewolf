import type { ActionProvider } from '../actions';
import { seatNames, type FlowObserver } from '../flow';
import { settleActions } from '../parallel';
import { campaignSpeechOrder, pkSpeechOrder, speechOrderReason } from '../speech-order';
import type { GameState, PlayerState } from '../state';
import { collectVotes, tallyVotes, type BallotObserver, type VoteRound } from '../vote';
import { runBlastWindow } from './self-destruct';
import type { NightDeath } from './announce';
import { speakInOrder, type Speech } from './speech';

/** 竞选结果；speeches 含警上发言与 PK 两轮。 */
export interface SheriffElectionResult {
  /** 选出警长之后的状态；警徽流失、竞选被打断时 sheriffId 仍是 null。 */
  state: GameState;
  /** 竞选被自爆打断，外层结算夜间死讯和死亡技能后入夜。 */
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
 * 上警和退水同时表态，收齐后统一公布；没人上警、警上全退水、
 * 全员上警、警下全弃票这四种都没有警长；只剩一名参选者直接当选，不投票。
 */
export async function runSheriffElection(
  state: GameState,
  actions: ActionProvider,
  minute: number,
  observe?: (state: GameState) => void,
  onBallot?: BallotObserver,
  onFlow?: FlowObserver,
  nightDeaths: readonly NightDeath[] = [],
): Promise<SheriffElectionResult> {
  const suspended = state.sheriffElectionSuspended;
  if (
    !state.hasSheriff ||
    state.sheriffElectionSettled ||
    (suspended === null && state.day !== 1)
  ) {
    return { state, aborted: false, speeches: [] };
  }

  // 续轮走到这里竞选就重新开张了，挂起标记先清掉：下面哪条路都不该再挂一次。
  const base: GameState =
    suspended === null
      ? state
      : {
          ...state,
          sheriffElectionSuspended: null,
          sheriffElectionCandidateIds: null,
        };
  observe?.(base);
  const alive = base.players.filter((player) => player.isAlive);
  const speeches: Speech[] = [];
  const idle = (from: GameState): SheriffElectionResult => ({
    state: { ...from, sheriffElectionSettled: true },
    aborted: false,
    speeches,
  });
  /** 首爆保留原上警名单及当前候选资格；二爆清空竞选。 */
  const suspend = (from: GameState, ids: readonly string[]): SheriffElectionResult => ({
    state: {
      ...from,
      sheriffElectionSuspended: ids.length > 0 ? campaign.map((player) => player.id) : null,
      sheriffElectionCandidateIds: ids.length > 0 ? ids : null,
      // 二爆作废，首爆仍挂起待续。
      sheriffElectionSettled: ids.length === 0,
    },
    aborted: true,
    speeches,
  });

  if (suspended === null) {
    await onFlow?.(base, {
      key: 'candidacy-start',
      text: '开始警长竞选，请所有存活玩家同时决定是否上警。',
    });
  }
  const campaign: PlayerState[] =
    suspended === null
      ? await askCandidacy(alive, actions)
      : alive.filter((player) => suspended.includes(player.id));
  const remaining =
    suspended === null
      ? campaign
      : campaign.filter((player) =>
          (state.sheriffElectionCandidateIds ?? suspended).includes(player.id),
        );

  await onFlow?.(base, {
    key: 'candidacy-result',
    kind: 'sheriff',
    text: remaining.length
      ? `${suspended === null ? '上警名单' : '剩余候选人'}：${seatNames(
          base,
          remaining.map((player) => player.id),
        )}。`
      : '无人上警，本局没有警长。',
  });

  // 续轮没走过警上发言，PK 顺序只能从这批人按单顺双逆排出来的次序里取。
  const campaignOrder = campaignSpeechOrder(
    remaining.map((player) => player.seatNo),
    minute,
  );

  if (remaining.length === 0) return idle(base);
  if (remaining.length === 1) return elect(base, speeches, remaining[0].id);

  if (suspended === null) {
    const blast = await runBlastWindow(base, 'campaign', actions, observe, onFlow, nightDeaths);
    // 首爆挂起竞选：警徽先留着，第二天从退水表态接着走。
    if (blast.blasted)
      return suspend(
        blast.state,
        campaign.map((player) => player.id),
      );
    await onFlow?.(base, {
      key: 'campaign-speech',
      text: `请警上玩家依次发言。${speechOrderReason(minute, campaignOrder)}顺序：${campaignOrder.map((seat) => `${seat} 号`).join('、')}。`,
    });
    speeches.push(...(await speakInOrder('campaign', campaignOrder, base.players, actions)));
  } else {
    const blast = await runBlastWindow(
      base,
      'campaign_resume',
      actions,
      observe,
      onFlow,
      nightDeaths,
    );
    // 二爆吞掉警徽：竞选到此作废，本局没有警长。
    if (blast.blasted) return suspend(blast.state, []);
  }

  // 全发完言再统一退水；退过水的人不能被选，也没有票。
  await onFlow?.(base, {
    key: 'withdraw-start',
    text:
      suspended === null
        ? '警上发言结束，请警上玩家同时决定是否退水。'
        : '继续警长竞选，请剩余候选人同时决定是否退水。',
  });
  const answers = await settleActions(remaining.map((player) => actions.withdraw(player.id)));
  const withdrawn = new Set(
    remaining.filter((_, index) => answers[index]).map((player) => player.id),
  );
  await onFlow?.(base, {
    key: 'withdraw-result',
    kind: 'sheriff',
    text: withdrawn.size ? `退水名单：${seatNames(base, [...withdrawn])}。` : '无人退水。',
  });

  const candidates = remaining.filter((player) => !withdrawn.has(player.id));
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
  await onFlow?.(base, {
    key: 'campaign-vote',
    text: `请警下玩家同时投票，警长候选人：${seatNames(base, round.candidates)}。`,
  });
  const ballot = await collectVotes(round, (voterId) =>
    actions.vote('campaign', voterId, round.candidates),
  );
  const outcome = tallyVotes(round, ballot);
  await onBallot?.({ round: 'campaign', casts: ballot, outcome });

  if (outcome.kind === 'elected') return elect(base, speeches, outcome.winnerId);
  if (outcome.kind === 'none') return idle(base);

  // 平票：平票者按相反顺序再发一轮言，同一批警下玩家再投一次。
  const tied = candidates.filter((player) => outcome.tiedIds.includes(player.id));
  const tiedSeatNos = new Set(tied.map((player) => player.seatNo));
  const pkOrder = pkSpeechOrder(campaignOrder, tiedSeatNos);
  const blast = await runBlastWindow(
    base,
    suspended === null ? 'campaign_pk' : 'campaign_resume_pk',
    actions,
    observe,
    onFlow,
    nightDeaths,
  );
  if (blast.blasted) return suspend(blast.state, suspended === null ? outcome.tiedIds : []);
  await onFlow?.(base, {
    key: 'campaign-pk',
    text: `警长竞选平票，请 ${seatNames(base, outcome.tiedIds)} 进行 PK 发言。`,
  });
  speeches.push(...(await speakInOrder('campaign_pk', pkOrder, base.players, actions)));

  const pkRound: VoteRound = { ...round, candidates: tied.map((player) => player.id) };
  await onFlow?.(base, { key: 'campaign-pk-vote', text: 'PK 发言结束，请警下玩家再次同时投票。' });
  const pkBallot = await collectVotes(pkRound, (voterId) =>
    actions.vote('campaign_pk', voterId, pkRound.candidates),
  );
  const pkOutcome = tallyVotes(pkRound, pkBallot);
  await onBallot?.({ round: 'campaign_pk', casts: pkBallot, outcome: pkOutcome });

  if (pkOutcome.kind === 'elected') return elect(base, speeches, pkOutcome.winnerId);

  // 再平票：警徽流失，本局没有警长。
  return idle(base);
}

/** 并发收齐答案，按原座位顺序保留名单。 */
async function askCandidacy(
  alive: readonly PlayerState[],
  actions: ActionProvider,
): Promise<PlayerState[]> {
  const answers = await settleActions(alive.map((player) => actions.runForSheriff(player.id)));
  return alive.filter((_, index) => answers[index]);
}

function elect(state: GameState, speeches: Speech[], winnerId: string): SheriffElectionResult {
  return {
    state: { ...state, sheriffId: winnerId, sheriffElectionSettled: true },
    aborted: false,
    speeches,
  };
}
