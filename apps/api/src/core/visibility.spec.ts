import { ROLES, VISIBILITY_TYPES, type VisibilityType } from '@werewolf/shared';
import { DEALABLE_ROLES, factionOf, inWolfChannel, type DealableRole } from './roles';
import type { PlayerState } from './state';
import { visibleVisibilities, type Observer } from './visibility';

function observer(role: DealableRole, overrides: Partial<Observer> = {}): Observer {
  return { role, isAlive: true, hasAntidoteUsed: false, ...overrides };
}

function player(role: DealableRole, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: 'p1',
    seatNo: 1,
    role,
    faction: factionOf(role),
    isAlive: true,
    deathDay: null,
    deathCause: null,
    hasAntidoteUsed: false,
    hasPoisonUsed: false,
    ...overrides,
  };
}

describe('狼队频道成员', () => {
  it('当前是狼人、白狼王与狼王', () => {
    // 可见性按身份判断而非按阵营，见 roles.ts 的 inWolfChannel。
    // 隐狼加进来时它不该出现在这里——狼阵营但不进狼队群。
    const members = DEALABLE_ROLES.filter((role: DealableRole) => inWolfChannel(role));
    expect(members).toEqual([ROLES.WEREWOLF, ROLES.WHITE_WOLF, ROLES.WOLF_KING]);
  });
});

describe('此刻能看见的可见性', () => {
  const cases: Array<[string, Observer, VisibilityType[]]> = [
    ['平民只看到公开信息', observer(ROLES.VILLAGER), [VISIBILITY_TYPES.PUBLIC]],
    [
      '预言家多一个自己的查验',
      observer(ROLES.SEER),
      [VISIBILITY_TYPES.PUBLIC, VISIBILITY_TYPES.SEER],
    ],
    [
      '女巫未用解药时能看到刀口',
      observer(ROLES.WITCH),
      [VISIBILITY_TYPES.PUBLIC, VISIBILITY_TYPES.WITCH, VISIBILITY_TYPES.WOLF_KILL],
    ],
    [
      '女巫用掉解药后不再看到刀口',
      observer(ROLES.WITCH, { hasAntidoteUsed: true }),
      [VISIBILITY_TYPES.PUBLIC, VISIBILITY_TYPES.WITCH],
    ],
    [
      '狼人看得到狼队商议与刀口',
      observer(ROLES.WEREWOLF),
      [VISIBILITY_TYPES.PUBLIC, VISIBILITY_TYPES.WOLF, VISIBILITY_TYPES.WOLF_KILL],
    ],
  ];

  it.each(cases)('%s', (_name, subject, expected) => {
    expect(visibleVisibilities(subject)).toEqual(expected);
  });

  it('刀口与狼队商议是两回事', () => {
    // 女巫知道刀口，但不该看到狼队内部怎么商量的。
    const witch = visibleVisibilities(observer(ROLES.WITCH));
    expect(witch).toContain(VISIBILITY_TYPES.WOLF_KILL);
    expect(witch).not.toContain(VISIBILITY_TYPES.WOLF);
  });

  it('任何角色都看不到系统内部事实', () => {
    for (const role of [ROLES.WEREWOLF, ROLES.SEER, ROLES.WITCH, ROLES.VILLAGER] as const) {
      expect(visibleVisibilities(observer(role))).not.toContain(VISIBILITY_TYPES.SYSTEM);
    }
  });
});

describe('出局', () => {
  it('出局后失去全部私密可见性，只剩公开事实', () => {
    // 出局者只剩旁观权：此后公开发言、投票结果、最终胜负他仍看得到，
    // 私密事实（狼队商议、刀口、查验、用药）不给。死前看到的事实由调用方用
    // 「当时还活着」的 Observer 判定，不受影响（见下一组用例）。
    for (const role of [ROLES.WEREWOLF, ROLES.SEER, ROLES.WITCH, ROLES.VILLAGER] as const) {
      expect(visibleVisibilities(observer(role, { isAlive: false }))).toEqual([
        VISIBILITY_TYPES.PUBLIC,
      ]);
    }
  });

  it('出局的狼人不再看到狼队商议，但公开信息仍然可见', () => {
    const deadWolf = visibleVisibilities(observer(ROLES.WEREWOLF, { isAlive: false }));
    expect(deadWolf).not.toContain(VISIBILITY_TYPES.WOLF);
    expect(deadWolf).not.toContain(VISIBILITY_TYPES.WOLF_KILL);
    expect(deadWolf).toContain(VISIBILITY_TYPES.PUBLIC);
  });
});

/**
 * 口径的完整表述：一条事实对某名玩家可见，当且仅当该玩家在事实发生的那一刻
 * 持有对应的可见性。用逐条推进的观察者状态模拟一次历史投影。
 */
function project(facts: Array<{ visibility: VisibilityType }>, observers: Observer[]) {
  return facts.filter((fact, index) =>
    visibleVisibilities(observers[index]).includes(fact.visibility),
  );
}

describe('按事实发生当时的状态判定', () => {
  it('女巫用掉解药后不再获得新的刀口，用药前看到的不会被追回', () => {
    const facts = [
      { visibility: VISIBILITY_TYPES.WOLF_KILL }, // 第 1 夜，尚未用药
      { visibility: VISIBILITY_TYPES.WOLF_KILL }, // 第 2 夜，已经用过药
    ];
    const observers = [observer(ROLES.WITCH), observer(ROLES.WITCH, { hasAntidoteUsed: true })];

    expect(project(facts, observers)).toEqual([facts[0]]);
  });

  it('女巫被刀：致死事实算在死亡之前，她看得到刀口指向自己', () => {
    // 这是「致死事实算在死亡之前」少数能被断言区分的形态：刀口既是致死事实，
    // 又是女巫自己看得到的事实。若把死亡时刻切在它之前，她连「刀口是我」都看不到，
    // 也就无从决定要不要用解药自救。把 observers[0] 换成已出局，这条会失败。
    const facts = [
      { visibility: VISIBILITY_TYPES.WOLF_KILL }, // 当晚刀口指向女巫自己
      { visibility: VISIBILITY_TYPES.PUBLIC }, // 次日公布死讯
      { visibility: VISIBILITY_TYPES.WITCH }, // 出局之后不再有新的私密事实
    ];
    const observers = [
      observer(ROLES.WITCH), // 致死事实算在死亡之前：那一刻她还活着，且未用解药
      observer(ROLES.WITCH, { isAlive: false }),
      observer(ROLES.WITCH, { isAlive: false }),
    ];

    expect(project(facts, observers)).toEqual([facts[0], facts[1]]);
  });

  it('白天放逐：出局者的记录里有自己怎么出局的', () => {
    // 「死者知道自己怎么出局的」只在这一种情形下成立——放逐结果是公开发布。
    // 下面那条夜间死亡的用例说明它不能当成通则。
    const facts = [
      { visibility: VISIBILITY_TYPES.WOLF }, // 放逐前的狼队商议
      { visibility: VISIBILITY_TYPES.PUBLIC }, // 放逐结果：致死事实本身
      { visibility: VISIBILITY_TYPES.WOLF }, // 出局之后的狼队商议
    ];
    // 正是靠逐条推进 Observer，前两条落在「出局前」、后一条落在「出局后」：
    // 复盘按这个分界切两段即可，不需要另写分段规则。
    const observers = [
      observer(ROLES.WEREWOLF),
      observer(ROLES.WEREWOLF),
      observer(ROLES.WEREWOLF, { isAlive: false }),
    ];

    expect(project(facts, observers)).toEqual([facts[0], facts[1]]);
  });

  it('夜间死亡：死者知道自己出局，但不知道自己怎么死的', () => {
    // 一只狼人夜里被女巫毒死。当晚的狼队商议与刀口发生在死亡之前，保留；
    // 而「他是被毒死的」只有女巫看得到，法官也不公布死因。
    const facts = [
      { visibility: VISIBILITY_TYPES.WOLF }, // 当晚狼队商议
      { visibility: VISIBILITY_TYPES.WOLF_KILL }, // 当晚刀口
      { visibility: VISIBILITY_TYPES.WITCH }, // 致死事实：女巫下毒（私密）
      { visibility: VISIBILITY_TYPES.PUBLIC }, // 次日公布死讯
      { visibility: VISIBILITY_TYPES.WOLF }, // 出局之后的狼队商议
    ];
    const observers = [
      observer(ROLES.WEREWOLF),
      observer(ROLES.WEREWOLF),
      observer(ROLES.WEREWOLF), // 致死事实算在死亡之前：那一刻他还活着
      observer(ROLES.WEREWOLF, { isAlive: false }),
      observer(ROLES.WEREWOLF, { isAlive: false }),
    ];

    // 致死事实活着也看不到（它是女巫的私密事实），所以他只知道「我出局了」。
    expect(project(facts, observers)).toEqual([facts[0], facts[1], facts[3]]);
  });
});

describe('与玩家状态的衔接', () => {
  it('PlayerState 可以直接当作观察者使用', () => {
    // 当前时刻不需要额外转换：玩家状态本身就带着可见性判断需要的三个字段。
    const alive = player(ROLES.WITCH);
    expect(visibleVisibilities(alive)).toEqual(visibleVisibilities(observer(ROLES.WITCH)));

    const used = player(ROLES.WITCH, { hasAntidoteUsed: true });
    expect(visibleVisibilities(used)).toEqual(
      visibleVisibilities(observer(ROLES.WITCH, { hasAntidoteUsed: true })),
    );
  });
});
