import { ACTION_TYPES } from '@werewolf/shared';
import { actionKey, parsePhaseInstanceId, phaseInstanceId, type ActionScope } from './identity';

/** 构造器保证产出合法身份，测试里用它造前置条件。 */
function scopeOf(ordinal: number, nodeName: string, gameId = 'g1'): ActionScope {
  return { gameId, phaseInstanceId: phaseInstanceId(ordinal, nodeName) };
}

describe('节点实例身份', () => {
  it('按 node/{序号}/{节点名} 组装', () => {
    expect(phaseInstanceId(0, 'init')).toBe('node/0/init');
    expect(phaseInstanceId(12, 'vote')).toBe('node/12/vote');
  });

  it('拒绝非非负整数的序号', () => {
    for (const ordinal of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => phaseInstanceId(ordinal, 'vote')).toThrow('节点序号必须是非负整数');
    }
  });

  it('拒绝不合法的节点名', () => {
    for (const nodeName of ['', '1vote', 'vote-phase', 'node/1/vote', '投票']) {
      expect(() => phaseInstanceId(1, nodeName)).toThrow('节点名不合法');
    }
  });

  describe('校验外来字符串', () => {
    it('接受本进程构造出来的身份', () => {
      for (const id of [phaseInstanceId(0, 'init'), phaseInstanceId(37, 'night_resolve')]) {
        expect(parsePhaseInstanceId(id)).toBe(id);
      }
    });

    it('拒绝形状不合法的字符串', () => {
      for (const value of [
        '',
        'vote',
        'node',
        'node/1',
        'node/1/',
        'node//vote',
        'node/x/vote',
        'node/1/vote/extra',
        'node/1/vote-phase',
      ]) {
        expect(parsePhaseInstanceId(value)).toBeNull();
      }
    });

    it('拒绝带前导零的序号', () => {
      // node/01/vote 与 node/1/vote 会指向同一个节点实例，放行等于破坏身份唯一性。
      expect(parsePhaseInstanceId('node/01/vote')).toBeNull();
    });

    it('拒绝超出安全整数范围的序号', () => {
      expect(parsePhaseInstanceId('node/99999999999999999999/vote')).toBeNull();
      expect(parsePhaseInstanceId(`node/${Number.MAX_SAFE_INTEGER}/vote`)).not.toBeNull();
    });
  });
});

describe('行动键', () => {
  it('同样输入得到同样的键', () => {
    const key = () => actionKey(scopeOf(3, 'vote'), ACTION_TYPES.VOTE, 'p2', 0);
    expect(key()).toBe(key());
  });

  it('组成是可直接读出的元组', () => {
    expect(actionKey(scopeOf(3, 'vote'), ACTION_TYPES.VOTE, 'p2', 1)).toBe(
      JSON.stringify(['g1', 'node/3/vote', 'vote', 'p2', 1]),
    );
  });

  it('改变任一组成部分都会改变键', () => {
    const base = actionKey(scopeOf(3, 'vote'), ACTION_TYPES.VOTE, 'p2', 0);
    const variants = [
      actionKey(scopeOf(3, 'vote', 'g2'), ACTION_TYPES.VOTE, 'p2', 0), // 换对局
      actionKey(scopeOf(4, 'vote'), ACTION_TYPES.VOTE, 'p2', 0), // 换节点实例
      actionKey(scopeOf(3, 'speech'), ACTION_TYPES.VOTE, 'p2', 0), // 换节点名
      actionKey(scopeOf(3, 'vote'), ACTION_TYPES.SPEECH, 'p2', 0), // 换事件类型
      actionKey(scopeOf(3, 'vote'), ACTION_TYPES.VOTE, 'p3', 0), // 换行动者
      actionKey(scopeOf(3, 'vote'), ACTION_TYPES.VOTE, 'p2', 1), // 换行动序号
    ];
    for (const variant of variants) expect(variant).not.toBe(base);
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('字段里带上分隔符也不会让两个行动共用一个键', () => {
    // 换成用分隔符拼接的写法时，这些取值就是最容易撞进去的一类输入。
    const keys = [
      actionKey(scopeOf(3, 'vote'), ACTION_TYPES.VOTE, 'a:b', 0),
      actionKey(scopeOf(3, 'vote'), ACTION_TYPES.VOTE, 'a', 0),
      actionKey(scopeOf(3, 'vote'), ACTION_TYPES.VOTE, 'a"b', 0),
      actionKey(
        { gameId: 'g:1', phaseInstanceId: phaseInstanceId(3, 'vote') },
        ACTION_TYPES.VOTE,
        'a',
        0,
      ),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('同一名玩家在相邻节点实例上的行动不会共用一个键', () => {
    // 节点实例序号在一局内单调递增，一次行动只可能落在一个实例上。
    const seen = new Set<string>();
    for (let ordinal = 0; ordinal < 50; ordinal += 1) {
      seen.add(actionKey(scopeOf(ordinal, 'vote'), ACTION_TYPES.VOTE, 'p2', 0));
    }
    expect(seen.size).toBe(50);
  });

  it('同一节点实例内多次行动靠行动序号区分', () => {
    const seen = new Set<string>();
    for (let actionOrdinal = 0; actionOrdinal < 9; actionOrdinal += 1) {
      seen.add(actionKey(scopeOf(7, 'vote'), ACTION_TYPES.VOTE, 'p2', actionOrdinal));
    }
    expect(seen.size).toBe(9);
  });

  it('拒绝无效输入', () => {
    expect(() => actionKey(scopeOf(3, 'vote', ''), ACTION_TYPES.VOTE, 'p2')).toThrow(
      '行动键缺少对局标识',
    );
    expect(() => actionKey(scopeOf(3, 'vote'), ACTION_TYPES.VOTE, '')).toThrow('行动键缺少行动者');
    expect(() => actionKey(scopeOf(3, 'vote'), ACTION_TYPES.VOTE, 'p2', -1)).toThrow(
      '行动序号必须是非负整数',
    );
  });
});
