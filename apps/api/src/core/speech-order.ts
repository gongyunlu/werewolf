/** 发言方向。顺时针即座位号递增。 */
export type SpeechDirection = 'clockwise' | 'counterclockwise';

/** 警长指定的发言起点侧。left 为逆时针，right 为顺时针。 */
export type SpeechSide = 'left' | 'right';

/**
 * 单顺双逆：由当前时间的分钟数个位定发言起点与方向。
 *
 * 个位是单数就从该座位号起顺时针，双数就从该座位号起逆时针。个位为 0 时没有
 * 0 号座位，按双数处理并从 1 号位起。
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

/**
 * 从 anchorSeatNo 出发按 direction 环绕遍历这批座位号。
 *
 * anchorSeatNo 不在集合里时沿方向顺延到下一个——座位号不存在和该座位的人没上警
 * 是同一件事，都落到这里。顺延不到就绕回集合起点。
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

/** 警上发言顺序：单顺双逆落在警上玩家这批人身上。 */
export function campaignSpeechOrder(campaignSeatNos: readonly number[], minute: number): number[] {
  const { anchorSeatNo, direction } = timeRule(minute);
  return speechOrderFrom(campaignSeatNos, anchorSeatNo, direction);
}

/**
 * 有警长时的白天发言顺序：警长指定从哪一侧开始，警长本人最后发言。
 *
 * 每天的左右由警长当次自行决定，没有交替规则。
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
 *
 * 「相反」是相对那一轮**实际发生**的发言而言的，所以要从实际顺序里筛，不能重算一遍
 * ——重算会在警长临时改方向时和实际不符。竞选 PK 与放逐 PK 共用这一条。
 */
export function pkSpeechOrder(
  order: readonly number[],
  tiedSeatNos: ReadonlySet<number>,
): number[] {
  return order.filter((seatNo) => tiedSeatNos.has(seatNo)).toReversed();
}

/**
 * 无警长时的白天发言顺序：方向按单顺双逆，起点在有死者时取最小座位号的死者。
 *
 * 死者已经不在存活集合里，起点落在他身上会沿方向顺延到下一位存活的玩家。
 */
export function daySpeechOrder(
  aliveSeatNos: readonly number[],
  deadSeatNos: readonly number[],
  minute: number,
): number[] {
  const { anchorSeatNo, direction } = timeRule(minute);
  const anchor = deadSeatNos.length > 0 ? Math.min(...deadSeatNos) : anchorSeatNo;

  return speechOrderFrom(aliveSeatNos, anchor, direction);
}
