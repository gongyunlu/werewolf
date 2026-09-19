/**
 * 放逐与警长竞选（含各自的平票 PK）共用的投票轮次，候选范围由调用方给。
 * 竞选阶段还没有警长，weightedVoterId 为 null。弃票不设开关，有投票权的人任何一轮都能不投。
 */
export interface VoteRound {
  /** 投票者 id。 */
  voters: readonly string[];
  /** 可选目标 id。 */
  candidates: readonly string[];
  /** 票权 1.5 的投票者（警长）；无则 null。 */
  weightedVoterId: string | null;
}

/** 一名投票者的落点。targetId 为 null 表示弃票。 */
export interface VoteCast {
  voterId: string;
  targetId: string | null;
}

/** 计票结果。 */
export type VoteOutcome =
  /** 唯一最高票，有人当选。voteCount 是加权后的票数。 */
  | { kind: 'elected'; winnerId: string; voteCount: number }
  /** 并列最高票，未决：tiedIds 至少两人，据此再打一轮 PK。 */
  | { kind: 'tie'; tiedIds: string[] }
  /** 零有效票，全员弃票。 */
  | { kind: 'none' };

/**
 * 计票。弃票不计入任何人的票数，警长的票按 1.5 计。
 * 只有唯一最高票才算当选，并列最高票一律返回 tie——平票自己消解不了，由调用方决定是否再 PK。
 */
export function tallyVotes(round: VoteRound, casts: readonly VoteCast[]): VoteOutcome {
  if (casts.length !== round.voters.length) {
    throw new Error(`投票未收齐：应收 ${round.voters.length} 票，实收 ${casts.length} 票`);
  }

  // 票数对得上不代表投票的是本人：同一人投两票、名单外的人投票（PK 台上的平票者、
  // 已经出局的警长都算）都按这批票不属于这一轮处理，长度校验兜不住这些。
  const voters = new Set(round.voters);
  const seen = new Set<string>();
  for (const cast of casts) {
    if (!voters.has(cast.voterId)) throw new Error(`投票者不在本轮名单内：${cast.voterId}`);
    if (seen.has(cast.voterId)) throw new Error(`同一名投票者投了两票：${cast.voterId}`);
    seen.add(cast.voterId);
  }

  const counts = new Map<string, number>();
  for (const cast of casts) {
    if (cast.targetId === null) continue;
    if (!round.candidates.includes(cast.targetId)) {
      throw new Error(`投票目标不在候选之内：${cast.targetId}`);
    }
    const weight = cast.voterId === round.weightedVoterId ? 1.5 : 1;
    counts.set(cast.targetId, (counts.get(cast.targetId) ?? 0) + weight);
  }

  // 全员弃票，不算平票（连最高票都没有），但处置跟平票未决一样。
  if (counts.size === 0) return { kind: 'none' };

  const max = Math.max(...counts.values());
  const tiedIds = [...counts.entries()]
    .filter(([, count]) => count === max)
    .map(([targetId]) => targetId);

  return tiedIds.length === 1
    ? { kind: 'elected', winnerId: tiedIds[0], voteCount: max }
    : { kind: 'tie', tiedIds };
}

/**
 * 收齐一轮投票：并行问完所有人，收齐才出结果。有人失败就整轮失败，不给失败者补弃票，
 * 补了等于把没投成伪装成弃票。
 */
export async function collectVotes(
  round: VoteRound,
  ask: (voterId: string) => Promise<string | null>,
): Promise<VoteCast[]> {
  return Promise.all(
    round.voters.map(async (voterId) => ({ voterId, targetId: await ask(voterId) })),
  );
}
