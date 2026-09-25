import { DEATH_CAUSES, FACTIONS, ROLES } from '@werewolf/shared';
import { makeState, stubActions, withRoles } from '../testing/fixtures';
import type { ActionProvider } from './actions';
import { nodeNameOf, phaseInstanceId } from './identity';
import { runGame, type GameLoopInput, type StageAnchor } from './loop';
import { patchPlayer, type GameState } from './state';

function stateAt(stage: string): GameState {
  return withRoles(
    { ...makeState(6, false), phaseInstanceId: phaseInstanceId(4, stage) },
    {
      p1: ROLES.WOLF_KING,
      p2: ROLES.WEREWOLF,
      p3: ROLES.HUNTER,
      p6: ROLES.SEER,
    },
  );
}

/** 停在下一夜入口，确保日终没有触发任何夜间操作。 */
function boundaryRun(state: GameState, actions: ActionProvider, input: unknown = {}) {
  let current = state;
  const judgments: GameState[] = [];
  const anchors: StageAnchor[] = [];
  const config: GameLoopInput = {
    state,
    actions,
    minuteOf: () => 0,
    resume: { state, phaseInstanceId: state.phaseInstanceId, input },
    observe: (next) => {
      current = next;
    },
    onStage: async (anchor) => {
      anchors.push(anchor);
      if (nodeNameOf(anchor.phaseInstanceId) === 'night') throw new Error('到下一夜为止');
    },
    onDayEnd: async () => {
      judgments.push(current);
    },
  };
  return { config, judgments, anchors };
}

describe('日终结算边界', () => {
  it('放逐技能连锁与警徽全部处理后才整理，下一夜尚未开始', async () => {
    let state = stateAt('exileSkills');
    state = patchPlayer({ ...state, sheriffId: 'p1' }, 'p1', {
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.EXECUTION,
    });
    const order: string[] = [];
    const { config, judgments, anchors } = boundaryRun(
      state,
      stubActions({
        wolfKingShot: async () => {
          order.push('狼王');
          return 'p3';
        },
        hunterShot: async () => {
          order.push('猎人');
          return 'p4';
        },
        decideBadge: async () => {
          order.push('警徽');
          return { kind: 'transfer', toId: 'p5' };
        },
      }),
      { deaths: [{ playerId: 'p1', cause: DEATH_CAUSES.EXECUTION }] },
    );
    await expect(runGame(config)).rejects.toThrow('到下一夜为止');
    expect(order).toEqual(['狼王', '猎人', '警徽']);
    expect(judgments).toHaveLength(1);
    expect(judgments[0].day).toBe(1);
    expect(judgments[0].sheriffId).toBe('p5');
    expect(judgments[0].players.filter((p) => p.isAlive).map((p) => p.id)).toEqual([
      'p2',
      'p5',
      'p6',
    ]);
    expect(anchors.map((anchor) => nodeNameOf(anchor.phaseInstanceId))).toEqual([
      'exileSkills',
      'dayEnd',
      'night',
    ]);
  });

  it('技能连锁触发终局时立即返回，不整理判断或进入下一夜', async () => {
    const state = patchPlayer(stateAt('exileSkills'), 'p1', {
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.EXECUTION,
    });
    const { config, judgments, anchors } = boundaryRun(
      state,
      stubActions({
        wolfKingShot: async () => 'p3',
        hunterShot: async () => 'p2',
      }),
      { deaths: [{ playerId: 'p1', cause: DEATH_CAUSES.EXECUTION }] },
    );
    expect((await runGame(config)).winner).toBe(FACTIONS.GOOD);
    expect(judgments).toEqual([]);
    expect(anchors).toHaveLength(1);
  });

  it.each([false, true])('白天结束时都整理，无人放逐或自爆中断：%s', async (blast) => {
    const state = withRoles(stateAt('day'), { p1: ROLES.WHITE_WOLF });
    const { config, judgments } = boundaryRun(
      state,
      stubActions({
        wolfBlast: async (id) => blast && id === 'p1',
        whiteWolfTake: async () => 'p3',
        hunterShot: async () => 'p4',
        speak: async () => '先观察。',
        vote: async () => null,
      }),
      { minute: 0 },
    );
    await expect(runGame(config)).rejects.toThrow('到下一夜为止');
    expect(judgments).toHaveLength(1);
    expect(judgments[0].players.filter((p) => !p.isAlive).map((p) => p.id)).toEqual(
      blast ? ['p1', 'p3', 'p4'] : [],
    );
  });

  it('警上自爆跳过白天时，仍在已公布的夜死技能结算之后整理', async () => {
    const state = patchPlayer(stateAt('deathSkills'), 'p3', {
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.NIGHT_KILL,
    });
    const { config, judgments, anchors } = boundaryRun(
      state,
      stubActions({ hunterShot: async () => 'p4' }),
      {
        deaths: [{ playerId: 'p3', cause: DEATH_CAUSES.NIGHT_KILL }],
        aborted: true,
      },
    );
    await expect(runGame(config)).rejects.toThrow('到下一夜为止');
    expect(anchors.map((anchor) => nodeNameOf(anchor.phaseInstanceId))).toEqual([
      'deathSkills',
      'dayEnd',
      'night',
    ]);
    expect(judgments[0].players.find((p) => p.id === 'p4')!.isAlive).toBe(false);
  });

  it('天亮公布死讯后已经终局，不形成日终判断', async () => {
    const state = withRoles(stateAt('dawn'), { p2: ROLES.VILLAGER });
    const { config, judgments } = boundaryRun(state, stubActions(), {
      deaths: [{ playerId: 'p1', cause: DEATH_CAUSES.NIGHT_KILL }],
      minute: 0,
    });
    expect((await runGame(config)).winner).toBe(FACTIONS.GOOD);
    expect(judgments).toEqual([]);
  });

  it('放逐最后一狼后立即终局，不因新增整理继续对局', async () => {
    const state = withRoles(stateAt('day'), { p2: ROLES.VILLAGER });
    const { config, judgments } = boundaryRun(
      state,
      stubActions({
        wolfBlast: async () => false,
        speak: async () => '投1号。',
        vote: async () => 'p1',
      }),
      { minute: 0 },
    );
    expect((await runGame(config)).winner).toBe(FACTIONS.GOOD);
    expect(judgments).toEqual([]);
  });

  it('达到天数上限不会额外生成没有后续用途的判断', async () => {
    const { config, judgments } = boundaryRun(
      stateAt('day'),
      stubActions({
        wolfBlast: async () => false,
        speak: async () => '观察。',
        vote: async () => null,
      }),
      { minute: 0 },
    );
    await expect(runGame({ ...config, maxDays: 1 })).rejects.toThrow('第 1 天还没分出胜负');
    expect(judgments).toEqual([]);
  });

  it('日终锚点恢复不重放白天或结算，保留原实例和截止输入', async () => {
    const state = stateAt('dayEnd');
    const { config, judgments, anchors } = boundaryRun(state, stubActions(), { ledgerSeq: 18 });
    await expect(runGame(config)).rejects.toThrow('到下一夜为止');
    expect(anchors[0]).toEqual(config.resume);
    expect(judgments).toHaveLength(1);
    expect(anchors[1].state.day).toBe(2);
  });
});
