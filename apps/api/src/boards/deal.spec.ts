import type { DealableRole } from '../core/roles';
import { ALL_BOARDS, handOf } from './boards';
import { shuffled, type RandomSource } from './deal';

/** 恒等源：每次取上界内的最后一个下标，等于不洗牌。也顺带钉住上界没越界。 */
const noShuffle: RandomSource = () => 0.999999;

/** 下界源：每次都跟上界内的第一个位置交换，一定会打乱。 */
const alwaysFirst: RandomSource = () => 0;

const hand = handOf(ALL_BOARDS['12p_wolf_king']);

function sorted(roles: readonly DealableRole[]): DealableRole[] {
  return [...roles].toSorted();
}

describe('发牌', () => {
  it('不洗牌时发出去的就是那手牌', () => {
    expect(shuffled(hand, noShuffle)).toEqual([...hand]);
  });

  it('打乱之后仍然是同一手牌，一张不多一张不少', () => {
    const dealt = shuffled(hand, alwaysFirst);

    expect(dealt).toHaveLength(hand.length);
    expect(sorted(dealt)).toEqual(sorted(hand));
    // 确认这个源真的洗动了，否则上面那条在恒等实现上也能过。
    expect(dealt).not.toEqual([...hand]);
  });

  it('不修改传进来的角色列表', () => {
    // 板子定义是模块级共享常量，一局洗乱会污染下一局，而且不会报错。
    const before = [...hand];
    shuffled(hand, alwaysFirst);

    expect(hand).toEqual(before);
  });

  it('空列表发出去还是空的', () => {
    expect(shuffled([], alwaysFirst)).toEqual([]);
  });
});

/**
 * 洗得均不均匀这里测不到：把 `i > 0` 写成 `i > 1` 上面四条照样全绿。
 * 均匀性得靠统计检验，不塞进单测。
 */
