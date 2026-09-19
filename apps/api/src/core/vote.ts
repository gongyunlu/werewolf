/**
 * 放逐、放逐平票 PK、警长竞选、竞选平票 PK 统一入口：
 * 放逐的候选是全部存活玩家，PK 与竞选的候选收窄到台上那几个人，
 * 只有警长竞选阶段尚未产生警长、weightedVoterId 为 null。
 *
 * 弃票不设开关：任何一轮投票，有投票权的人都可以选择不投。
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

/**
 * 计票结果
 */
export type VoteOutcome =
  /** 唯一最高票，有人当选。voteCount 是加权后的票数，可能是 x.5。 */
  | { kind: 'elected'; winnerId: string; voteCount: number }
  /** 并列最高票，未决：tiedIds 至少两人。放逐与竞选都据此再打一轮 PK。 */
  | { kind: 'tie'; tiedIds: string[] }
  /** 零有效票，全员弃票。没有任何人得票，所以不携带数据。 */
  | { kind: 'none' };

/**
 * 计票。
 *
 * 弃票不计入任何人的票数。警长的票按 1.5 计。
 *
 * 只有唯一最高票才算当选：并列最高票一律返回 tie，由调用方决定是再 PK 一轮
 * （放逐、竞选）还是就此作罢，平票本身不是一个可以自行消解的结局。
 */
export function tallyVotes(round: VoteRound, casts: readonly VoteCast[]): VoteOutcome {
  if (casts.length !== round.voters.length) {
    throw new Error(`投票未收齐：应收 ${round.voters.length} 票，实收 ${casts.length} 票`);
  }

  // 票数对得上不等于投票的是本人：同一人投两票会让票数凭空多出来，名单外的人投票
  // 则是没资格的人参与了计票（PK 台上的平票者、已经出局的警长都属此类）。两者都按
  // 「这批票不属于这一轮」处理，不能靠上面那条长度校验兜住。
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

  // 一张有效票都没有：全员弃票。这不是平票（连最高票都不存在），但各环节给它的
  // 处置与平票未决相同——放逐无人出局，竞选警徽流失。
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
 * 收齐一轮投票：并行问完全部投票者，收齐后才产出结果。
 *
 * 任一投票失败即整轮失败，不给失败者补一张弃票——补票会把「这轮没能投成」
 * 伪装成「这名玩家弃票」，计票结果就不再反映真实输入。
 */
export async function collectVotes(
  round: VoteRound,
  ask: (voterId: string) => Promise<string | null>,
): Promise<VoteCast[]> {
  return Promise.all(
    round.voters.map(async (voterId) => ({ voterId, targetId: await ask(voterId) })),
  );
}
