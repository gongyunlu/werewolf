/** 发言方向。顺时针即座位号递增。 */
export type SpeechDirection = 'clockwise' | 'counterclockwise';

/** 警长指定的发言起点侧。left 为逆时针，right 为顺时针。 */
export type SpeechSide = 'left' | 'right';

/**
 * 单顺双逆：按当前时间的分钟数个位定起点和方向。单数从该座位号起顺时针，双数起逆时针；
 * 个位 0 没有 0 号座位，按双数处理，从 1 号位起。
 */
export function timeRule(minute: number): {
  anchorSeatNo: number;
  direction: SpeechDirection;
} {
  const units = minute % 10;
  if (units === 0) return { anchorSeatNo: 1, direction: 'counterclockwise' };

  return {
    anchorSeatNo: units,
    direction: units % 2 === 1 ? 'clockwise' : 'counterclockwise',
  };
}

/** 与实际排序共用取时规则，播报原始起点及顺延后的首位。 */
export function speechOrderReason(
  minute: number,
  order: readonly number[],
  deadSeatNos: readonly number[] = [],
): string {
  const { anchorSeatNo, direction } = timeRule(minute);
  const anchor = deadSeatNos.length > 0 ? Math.min(...deadSeatNos) : anchorSeatNo;
  const start =
    deadSeatNos.length > 0
      ? `以今天出局者中座位号最小的 ${anchor} 号为起点`
      : `以 ${anchor} 号为起点${minute % 10 === 0 ? '（个位为 0，取 1 号）' : ''}`;
  return `本轮取时分钟数为 ${minute}，个位为 ${minute % 10}，按单顺双逆${direction === 'clockwise' ? '顺时针' : '逆时针'}发言；${start}，跳过不参与本轮的座位，从 ${order[0]} 号开始。`;
}

/**
 * 从 anchorSeatNo 出发按 direction 环绕遍历这批座位号。anchorSeatNo 不在集合里
 * （座位号不存在、或那人没上警）就沿方向顺延，顺延不到就绕回集合起点。
 */
export function speechOrderFrom(
  seatNos: readonly number[],
  anchorSeatNo: number,
  direction: SpeechDirection,
): number[] {
  const sorted = [...seatNos].toSorted((a, b) => a - b);
  const walked = direction === 'clockwise' ? sorted : sorted.toReversed();

  const index =
    direction === 'clockwise'
      ? walked.findIndex((seatNo) => seatNo >= anchorSeatNo)
      : walked.findIndex((seatNo) => seatNo <= anchorSeatNo);
  const start = index === -1 ? 0 : index;

  return [...walked.slice(start), ...walked.slice(0, start)];
}

/** 警上发言顺序：单顺双逆，范围是上警的这批人。 */
export function campaignSpeechOrder(campaignSeatNos: readonly number[], minute: number): number[] {
  const { anchorSeatNo, direction } = timeRule(minute);
  return speechOrderFrom(campaignSeatNos, anchorSeatNo, direction);
}

/**
 * 有警长时的白天发言顺序：警长指定从哪一侧开始，本人最后发言。
 * 左右每天由警长当次决定，没有交替规则。
 */
export function sheriffSpeechOrder(
  aliveSeatNos: readonly number[],
  sheriffSeatNo: number,
  side: SpeechSide,
): number[] {
  const direction: SpeechDirection = side === 'left' ? 'counterclockwise' : 'clockwise';
  const others = aliveSeatNos.filter((seatNo) => seatNo !== sheriffSeatNo);

  return [...speechOrderFrom(others, sheriffSeatNo, direction), sheriffSeatNo];
}

/**
 * 平票 PK 的发言顺序：从上一轮的顺序里筛出平票者，再整体倒过来。
 * 必须拿实际走过的那轮顺序筛，不能重算，理由见 day/exile.ts。竞选 PK 与放逐 PK 共用。
 */
export function pkSpeechOrder(
  order: readonly number[],
  tiedSeatNos: ReadonlySet<number>,
): number[] {
  return order.filter((seatNo) => tiedSeatNos.has(seatNo)).toReversed();
}

/** 无警长时的白天发言顺序：方向按单顺双逆，有死者时起点取最小座位号的死者。 */
export function daySpeechOrder(
  aliveSeatNos: readonly number[],
  deadSeatNos: readonly number[],
  minute: number,
): number[] {
  const { anchorSeatNo, direction } = timeRule(minute);
  const anchor = deadSeatNos.length > 0 ? Math.min(...deadSeatNos) : anchorSeatNo;

  return speechOrderFrom(aliveSeatNos, anchor, direction);
}
