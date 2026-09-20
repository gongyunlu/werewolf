import { z } from 'zod';
import { decisionShape, type DecisionShape } from './decisions';

/** 座位号换回玩家 id 的对照，用例里就是座位号加个前缀。 */
const TO_ID = (seatNo: number): string => `p${seatNo}`;

/** 这份形状收不收这个答案。断言走 schema，因为模型那一侧的约束就是它。 */
function accepts(shape: DecisionShape, answer: unknown): boolean {
  return shape.schema !== undefined && shape.schema.safeParse(answer).success;
}

/** 形状里的座位取值集，从它生成的 JSON Schema 里读回来：多值落成 enum，单值落成 const。 */
function seatsIn(shape: DecisionShape): unknown {
  const json = z.toJSONSchema(shape.schema as z.ZodType) as { enum?: unknown; const?: unknown };
  return json.enum ?? [json.const];
}

describe('决定形状', () => {
  it('座位取值集按候选现算，顺序也照候选', () => {
    expect(seatsIn(decisionShape('seat', { seatNos: [7, 3] }))).toEqual([7, 3]);
    expect(seatsIn(decisionShape('seat', { seatNos: [4] }))).toEqual([4]);
  });

  it('没在候选里的座位答了也不作数', () => {
    const shape = decisionShape('seat', { seatNos: [2, 5] });

    expect(accepts(shape, 2)).toBe(true);
    expect(accepts(shape, 5)).toBe(true);
    expect(accepts(shape, 3)).toBe(false);
  });

  it('座位号是数，不是字符串', () => {
    const shape = decisionShape('seat', { seatNos: [2] });

    expect(accepts(shape, 2)).toBe(true);
    expect(accepts(shape, '2')).toBe(false);
  });

  it('座位号换回玩家 id 只在 toCore 这一处', () => {
    const shape = decisionShape('seat', { seatNos: [2, 5] });

    expect(shape.toCore(5, TO_ID)).toBe('p5');
  });

  it('候选为空就是上游算错了，当场抛', () => {
    expect(() => decisionShape('seat', { seatNos: [] })).toThrow('候选为空');
    expect(() => decisionShape('seatOrNone', { seatNos: [] })).toThrow('候选为空');
  });

  it('做/不做那一档多一个 null，其余取值照旧', () => {
    const shape = decisionShape('seatOrNone', { seatNos: [4] });

    expect(accepts(shape, 4)).toBe(true);
    expect(accepts(shape, null)).toBe(true);
    expect(accepts(shape, 1)).toBe(false);
    expect(shape.toCore(4, TO_ID)).toBe('p4');
    expect(shape.toCore(null, TO_ID)).toBeNull();
  });

  it('发言没有 schema，草稿原文就是结果', () => {
    const shape = decisionShape('speech', { seatNos: [] });

    expect(shape.schema).toBeUndefined();
    expect(shape.toCore('我先过，听后面的。', TO_ID)).toBe('我先过，听后面的。');
  });

  it('二态与发言方向各自卡住取值', () => {
    const yesNo = decisionShape('yesOrNo', { seatNos: [] });
    expect(accepts(yesNo, true)).toBe(true);
    expect(accepts(yesNo, 'true')).toBe(false);

    const side = decisionShape('speechSide', { seatNos: [] });
    expect(accepts(side, 'left')).toBe(true);
    expect(accepts(side, 'up')).toBe(false);
    expect(side.toCore('right', TO_ID)).toBe('right');
  });

  describe('女巫那一问', () => {
    it('救、毒、不用三支都在时是三选一', () => {
      const shape = decisionShape('witchDecision', { seatNos: [3], antidoteAllowed: true });

      expect(accepts(shape, { kind: 'antidote' })).toBe(true);
      expect(accepts(shape, { kind: 'poison', seatNo: 3 })).toBe(true);
      expect(accepts(shape, { kind: 'none' })).toBe(true);
    });

    it('不能自救时救的那一支根本不摆出来', () => {
      const shape = decisionShape('witchDecision', { seatNos: [3], antidoteAllowed: false });

      expect(accepts(shape, { kind: 'antidote' })).toBe(false);
      expect(accepts(shape, { kind: 'poison', seatNo: 3 })).toBe(true);
      expect(accepts(shape, { kind: 'none' })).toBe(true);
    });

    it('毒药没得毒时那一支也不摆，只剩不用', () => {
      const shape = decisionShape('witchDecision', { seatNos: [], antidoteAllowed: false });

      expect(accepts(shape, { kind: 'none' })).toBe(true);
      expect(accepts(shape, { kind: 'antidote' })).toBe(false);
      expect(accepts(shape, { kind: 'poison', seatNo: 1 })).toBe(false);
    });

    it('没说解药能不能用就是上游漏传了，当场抛', () => {
      // 给个默认值等于替 Core 决定那一晚能不能救人，摆出来的可能是她用不了的药。
      expect(() => decisionShape('witchDecision', { seatNos: [3] })).toThrow('解药能不能用');
    });

    it('毒的目标同样得在候选里', () => {
      const shape = decisionShape('witchDecision', { seatNos: [3], antidoteAllowed: true });

      expect(accepts(shape, { kind: 'poison', seatNo: 1 })).toBe(false);
    });

    it('毒那支换成 Core 要的 targetId，另两支原样带过去', () => {
      const shape = decisionShape('witchDecision', { seatNos: [3], antidoteAllowed: true });

      expect(shape.toCore({ kind: 'poison', seatNo: 3 }, TO_ID)).toEqual({
        kind: 'poison',
        targetId: 'p3',
      });
      expect(shape.toCore({ kind: 'antidote' }, TO_ID)).toEqual({ kind: 'antidote' });
      expect(shape.toCore({ kind: 'none' }, TO_ID)).toEqual({ kind: 'none' });
    });
  });

  it('警徽只能移交给候选里的存活玩家，或者撕掉', () => {
    const shape = decisionShape('badgeDecision', { seatNos: [2] });

    expect(accepts(shape, { kind: 'transfer', seatNo: 2 })).toBe(true);
    expect(accepts(shape, { kind: 'tear' })).toBe(true);
    expect(accepts(shape, { kind: 'transfer', seatNo: 5 })).toBe(false);
    expect(shape.toCore({ kind: 'transfer', seatNo: 2 }, TO_ID)).toEqual({
      kind: 'transfer',
      toId: 'p2',
    });
    expect(shape.toCore({ kind: 'tear' }, TO_ID)).toEqual({ kind: 'tear' });
  });
});
