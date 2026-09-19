import type { DealableRole } from '../core/roles';
import { ALL_BOARDS, handOf } from './boards';
import { dealRoles, type RandomSource } from './deal';

/**
 * 恒等源：每次都取上界内的最后一个下标，等于不洗牌。它同时钉住上界没越界——
 * random() * n 那种写法会让这个源算出越界下标，结果不再是原序。
 */
const noShuffle: RandomSource = () => 0.999999;

/** 下界源：每次都跟上界内的第一个位置交换，一定会打乱。 */
const alwaysFirst: RandomSource = () => 0;

const hand = handOf(ALL_BOARDS['12p_wolf_king']);

function sorted(roles: readonly DealableRole[]): DealableRole[] {
  return [...roles].toSorted();
}

describe('发牌', () => {
  it('不洗牌时发出去的就是那手牌', () => {
    expect(dealRoles(hand, noShuffle)).toEqual([...hand]);
  });

  it('打乱之后仍然是同一手牌，一张不多一张不少', () => {
    const dealt = dealRoles(hand, alwaysFirst);

    expect(dealt).toHaveLength(hand.length);
    expect(sorted(dealt)).toEqual(sorted(hand));
    // 顺带说明这个源真的洗动了，否则上一条「多重集相同」可以在一个恒等实现上通过。
    expect(dealt).not.toEqual([...hand]);
  });

  it('不修改传进来的角色列表', () => {
    // 板子定义是模块级共享常量，一局洗乱会污染下一局，而且没有任何东西会报错。
    const before = [...hand];
    dealRoles(hand, alwaysFirst);

    expect(hand).toEqual(before);
  });

  it('空列表发出去还是空的', () => {
    expect(dealRoles([], alwaysFirst)).toEqual([]);
  });
});

/**
 * 这个文件测不到什么：洗得均不均匀。把循环条件 `i > 0` 写成 `i > 1`
 * （最后一张永远不参与交换）时上面四条全绿——那仍然是一个合法排列。
 * 分布均匀性要统计检验，不该塞进单元测试，也不该声称覆盖了。
 */
