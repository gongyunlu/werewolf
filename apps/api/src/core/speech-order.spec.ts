import {
  campaignSpeechOrder,
  daySpeechOrder,
  pkSpeechOrder,
  sheriffSpeechOrder,
  speechOrderFrom,
  speechOrderReason,
  timeRule,
} from './speech-order';

describe('单顺双逆', () => {
  it('播报分钟个位、方向、原始起点与实际首位', () => {
    expect(speechOrderReason(26, campaignSpeechOrder([1, 3, 5], 26))).toBe(
      '本轮取时分钟数为 26，个位为 6，按单顺双逆逆时针发言；以 6 号为起点，跳过不参与本轮的座位，从 5 号开始。',
    );
    expect(speechOrderReason(20, campaignSpeechOrder([2, 5], 20))).toContain(
      '以 1 号为起点（个位为 0，取 1 号）',
    );
    expect(speechOrderReason(25, daySpeechOrder([1, 3, 5], [2, 4], 25), [2, 4])).toContain(
      '以今天出局者中座位号最小的 2 号为起点，跳过不参与本轮的座位，从 3 号开始。',
    );
  });

  it('个位是单数就从该座位号起顺时针', () => {
    expect(timeRule(25)).toEqual({ anchorSeatNo: 5, direction: 'clockwise' });
    expect(timeRule(3)).toEqual({ anchorSeatNo: 3, direction: 'clockwise' });
  });

  it('个位是双数就从该座位号起逆时针', () => {
    expect(timeRule(26)).toEqual({ anchorSeatNo: 6, direction: 'counterclockwise' });
    expect(timeRule(48)).toEqual({ anchorSeatNo: 8, direction: 'counterclockwise' });
  });

  it('个位为 0 时没有 0 号座位，从 1 号位起逆时针', () => {
    expect(timeRule(0)).toEqual({ anchorSeatNo: 1, direction: 'counterclockwise' });
    expect(timeRule(10)).toEqual({ anchorSeatNo: 1, direction: 'counterclockwise' });
    expect(timeRule(60)).toEqual({ anchorSeatNo: 1, direction: 'counterclockwise' });
  });
});

describe('环绕遍历座位号', () => {
  it('起点在集合里就从它开始', () => {
    expect(speechOrderFrom([2, 4, 5, 7], 4, 'clockwise')).toEqual([4, 5, 7, 2]);
    expect(speechOrderFrom([2, 4, 5, 7], 4, 'counterclockwise')).toEqual([4, 2, 7, 5]);
  });

  it('起点不在集合里就顺着方向顺延到下一个', () => {
    // 计算出来的号码没人上警，等同于该座位不存在。
    expect(speechOrderFrom([3, 5, 9], 4, 'clockwise')).toEqual([5, 9, 3]);
    expect(speechOrderFrom([3, 5, 9], 4, 'counterclockwise')).toEqual([3, 9, 5]);
  });

  it('沿方向顺延不到就绕回集合另一端', () => {
    expect(speechOrderFrom([2, 4], 5, 'clockwise')).toEqual([2, 4]);
    expect(speechOrderFrom([2, 4], 1, 'counterclockwise')).toEqual([4, 2]);
  });

  it('不重复也不丢人', () => {
    const order = speechOrderFrom([1, 3, 6, 8, 11], 7, 'counterclockwise');
    expect([...order].toSorted((a, b) => a - b)).toEqual([1, 3, 6, 8, 11]);
  });
});

describe('警上发言顺序', () => {
  it('起点与方向都按单顺双逆落在警上这批人身上', () => {
    // 15:32，个位 2 双数，从 2 号位起逆时针。
    expect(campaignSpeechOrder([2, 5, 7, 11], 32)).toEqual([2, 11, 7, 5]);
    // 15:25，个位 5 单数，从 5 号位起顺时针。
    expect(campaignSpeechOrder([2, 5, 7, 11], 25)).toEqual([5, 7, 11, 2]);
  });

  it('算出来的号码没上警就顺延', () => {
    expect(campaignSpeechOrder([3, 6, 9], 5)).toEqual([6, 9, 3]);
  });
});

describe('有警长时的发言顺序', () => {
  const alive = [1, 2, 3, 4, 5];

  it('从左起就逆时针转，警长最后发言', () => {
    expect(sheriffSpeechOrder(alive, 3, 'left')).toEqual([2, 1, 5, 4, 3]);
  });

  it('从右起就顺时针转，警长最后发言', () => {
    expect(sheriffSpeechOrder(alive, 3, 'right')).toEqual([4, 5, 1, 2, 3]);
  });

  it('警长指定的方向与时间无关', () => {
    expect(sheriffSpeechOrder(alive, 3, 'left')).toEqual(sheriffSpeechOrder(alive, 3, 'left'));
  });

  it('死人不参与发言，警长仍然压轴', () => {
    expect(sheriffSpeechOrder([1, 3, 4, 5], 3, 'right')).toEqual([4, 5, 1, 3]);
  });
});

describe('平票 PK 的发言顺序', () => {
  it('从上一轮的顺序里筛出平票者，再整体倒过来', () => {
    expect(pkSpeechOrder([2, 1, 3], new Set([1, 3]))).toEqual([3, 1]);
  });

  it('筛的是上一轮的实际顺序，不是座位号', () => {
    // 同一批平票者，上一轮顺序不同则 PK 顺序不同。
    expect(pkSpeechOrder([3, 1, 2], new Set([1, 3]))).toEqual([1, 3]);
    expect(pkSpeechOrder([1, 2, 3], new Set([1, 3]))).toEqual([3, 1]);
  });

  it('只有一名平票者时就是他自己', () => {
    expect(pkSpeechOrder([2, 1, 3], new Set([2]))).toEqual([2]);
  });
});

describe('无警长时的发言顺序', () => {
  it('没有死者时起点按单顺双逆', () => {
    expect(daySpeechOrder([1, 2, 3], [], 26)).toEqual([3, 2, 1]);
  });

  it('有死者时起点取最小座位号的死者，方向仍按单顺双逆', () => {
    // 死者 1、4，取 1 号位为起点；个位 5 单数，顺时针。
    expect(daySpeechOrder([2, 3, 5, 6], [1, 4], 25)).toEqual([2, 3, 5, 6]);
  });

  it('死者坐在起点上就顺延到下一位存活的玩家', () => {
    // 死者 5 号位；个位 3 单数顺时针，从 5 号位起顺延绕回 2 号位。
    expect(daySpeechOrder([2, 4], [5], 23)).toEqual([2, 4]);
    // 个位 4 双数逆时针，从 5 号位起顺延到 4 号位。
    expect(daySpeechOrder([2, 4], [5], 24)).toEqual([4, 2]);
  });
});
