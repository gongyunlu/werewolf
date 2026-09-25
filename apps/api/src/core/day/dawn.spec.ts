import { DEATH_CAUSES, FACTIONS, ROLES } from '@werewolf/shared';
import { makeState, playerOf, stubActions, withRoles } from '../../testing/fixtures';
import type { FlowEvent } from '../flow';
import type { GameState } from '../state';
import { checkWin } from '../win';
import { announceDay } from './announce';
import { runDawn } from './dawn';

function board() {
  return withRoles(makeState(8), {
    p1: ROLES.WHITE_WOLF,
    p2: ROLES.WEREWOLF,
    p3: ROLES.SEER,
    p4: ROLES.HUNTER,
    p5: ROLES.WITCH,
  });
}

describe('竞选之后公布夜间死讯', () => {
  it.each([DEATH_CAUSES.NIGHT_KILL, DEATH_CAUSES.WITCH_POISON])(
    '夜间待死者自爆，实际死因覆盖为自爆且不重复公告：%s',
    async (cause) => {
      const state = withRoles(board(), { p1: ROLES.WOLF_KING });
      const events: FlowEvent[] = [];
      const nightDeaths = [
        { playerId: 'p1', cause },
        { playerId: 'p8', cause: DEATH_CAUSES.NIGHT_KILL },
      ];
      const result = await runDawn({
        state,
        deaths: nightDeaths,
        minute: 22,
        actions: stubActions({
          runForSheriff: async (id) => id === 'p3' || id === 'p4',
          wolfBlast: async (id) => id === 'p1',
        }),
        onFlow: async (announced, event) => {
          events.push(event);
          if (event.key === 'campaign-blast-result') {
            expect(playerOf(announced, 'p1')).toMatchObject({
              isAlive: false,
              deathCause: DEATH_CAUSES.SELF_DESTRUCT,
            });
          }
        },
      });

      expect(result.aborted).toBe(true);
      expect(result.state.sheriffElectionSuspended).toEqual(['p3', 'p4']);
      expect(playerOf(result.state, 'p1').deathCause).toBe(DEATH_CAUSES.SELF_DESTRUCT);
      expect(result.deaths).toEqual([{ playerId: 'p8', cause: DEATH_CAUSES.NIGHT_KILL }]);
      expect(events.find((event) => event.key === 'dawn')?.text).toBe('昨晚 8 号 倒牌。');
      expect(events.findIndex((event) => event.key === 'campaign-blast-result')).toBeLessThan(
        events.findIndex((event) => event.key === 'dawn'),
      );
      expect(nightDeaths[0]).toEqual({ playerId: 'p1', cause });
      expect(state.players.every((player) => player.isAlive)).toBe(true);
    },
  );

  it('白狼王选中夜间待死的人，这一枪空放', async () => {
    const events: FlowEvent[] = [];
    const result = await runDawn({
      state: board(),
      deaths: [{ playerId: 'p4', cause: DEATH_CAUSES.NIGHT_KILL }],
      minute: 22,
      actions: stubActions({
        runForSheriff: async (id) => id === 'p3' || id === 'p4',
        wolfBlast: async (id) => id === 'p1',
        whiteWolfTake: async () => 'p4',
      }),
      onFlow: async (_state, event) => {
        events.push(event);
      },
    });
    // p4 夜里已经中刀，白狼王挑中他也带不走：他留在夜间名单里，照刀公布。
    expect(events.some((event) => event.key === 'campaign-blast-take')).toBe(false);
    expect(result.deaths).toEqual([{ playerId: 'p4', cause: DEATH_CAUSES.NIGHT_KILL }]);
    expect(events.find((event) => event.key === 'dawn')?.text).toBe('昨晚 4 号 倒牌。');
  });

  it.each([
    [ROLES.HUNTER, DEATH_CAUSES.NIGHT_KILL],
    [ROLES.HUNTER, DEATH_CAUSES.WITCH_POISON],
    [ROLES.WOLF_KING, DEATH_CAUSES.NIGHT_KILL],
    [ROLES.WOLF_KING, DEATH_CAUSES.WITCH_POISON],
  ] as const)('白狼王触发 %s 的技能，选中夜间 %s 目标不覆盖死讯', async (role, cause) => {
    const events: FlowEvent[] = [];
    const nightDeaths = [{ playerId: 'p8', cause }];
    const shoot = jest.fn(async (_id: string, candidates: readonly string[]) => {
      expect(candidates).toContain('p8');
      return 'p8';
    });
    const result = await runDawn({
      state: withRoles(board(), { p4: role }),
      deaths: nightDeaths,
      minute: 22,
      actions: stubActions({
        runForSheriff: async (id) => id === 'p3' || id === 'p4',
        wolfBlast: async (id) => id === 'p1',
        whiteWolfTake: async () => 'p4',
        ...(role === ROLES.HUNTER ? { hunterShot: shoot } : { wolfKingShot: shoot }),
      }),
      onFlow: async (_state, event) => {
        events.push(event);
      },
    });

    expect(shoot).toHaveBeenCalledTimes(1);
    expect(playerOf(result.state, 'p8').deathCause).toBe(cause);
    expect(result.deaths).toEqual(nightDeaths);
    expect(events.some((event) => event.key === 'death-skill-p4')).toBe(false);
    expect(events.find((event) => event.key === 'dawn')?.text).toBe('昨晚 8 号 倒牌。');
    expect(nightDeaths).toEqual([{ playerId: 'p8', cause }]);
  });

  it('多层连锁也不能让夜间中毒的猎人获得开枪机会', async () => {
    const state = withRoles(board(), {
      p2: ROLES.WOLF_KING,
      p6: ROLES.WEREWOLF,
      p8: ROLES.HUNTER,
    });
    const hunterShot = jest.fn(async (id: string) => {
      if (id !== 'p4') throw new Error('中毒猎人不能开枪');
      return 'p2';
    });
    const result = await runDawn({
      state,
      deaths: [{ playerId: 'p8', cause: DEATH_CAUSES.WITCH_POISON }],
      minute: 22,
      actions: stubActions({
        runForSheriff: async (id) => id === 'p3' || id === 'p4',
        wolfBlast: async (id) => id === 'p1',
        whiteWolfTake: async () => 'p4',
        hunterShot,
        wolfKingShot: async () => 'p8',
      }),
    });

    expect(hunterShot).toHaveBeenCalledTimes(1);
    expect(playerOf(result.state, 'p2').deathCause).toBe(DEATH_CAUSES.HUNTER_SHOT);
    expect(playerOf(result.state, 'p8').deathCause).toBe(DEATH_CAUSES.WITCH_POISON);
    expect(result.deaths).toEqual([{ playerId: 'p8', cause: DEATH_CAUSES.WITCH_POISON }]);
  });

  it('连锁空放不提前屠边，仍公布夜间死亡并按完整结果判胜负', async () => {
    const state = withRoles(makeState(6), {
      p1: ROLES.WHITE_WOLF,
      p2: ROLES.WEREWOLF,
      p3: ROLES.HUNTER,
      p5: ROLES.WITCH,
      p6: ROLES.GUARD,
    });
    const nightDeaths = [
      { playerId: 'p4', cause: DEATH_CAUSES.NIGHT_KILL },
      { playerId: 'p2', cause: DEATH_CAUSES.WITCH_POISON },
    ];
    const result = await runDawn({
      state,
      deaths: nightDeaths,
      minute: 22,
      actions: stubActions({
        runForSheriff: async (id) => id === 'p1' || id === 'p3',
        wolfBlast: async (id) => id === 'p1',
        whiteWolfTake: async () => 'p3',
        hunterShot: async () => 'p4',
      }),
    });

    expect(result.deaths).toEqual(nightDeaths);
    expect(playerOf(result.state, 'p4').deathCause).toBe(DEATH_CAUSES.NIGHT_KILL);
    expect(playerOf(result.state, 'p2').deathCause).toBe(DEATH_CAUSES.WITCH_POISON);
    expect(checkWin(result.state)).toBe(FACTIONS.GOOD);
  });

  it('吃毒白狼王可以自爆打断竞选，但不会获得带人机会', async () => {
    const result = await runDawn({
      state: board(),
      deaths: [{ playerId: 'p1', cause: DEATH_CAUSES.WITCH_POISON }],
      minute: 22,
      actions: stubActions({
        runForSheriff: async (id) => id === 'p3' || id === 'p4',
        wolfBlast: async (id) => id === 'p1',
      }),
    });
    expect(result.aborted).toBe(true);
    expect(result.deaths).toEqual([]);
    expect(playerOf(result.state, 'p1').deathCause).toBe(DEATH_CAUSES.SELF_DESTRUCT);
    expect(
      result.state.players.filter((player) => !player.isAlive).map((player) => player.id),
    ).toEqual(['p1']);
  });

  it('次日续选保留第二夜待死者的参选和警下投票资格，排除首日已出局者', async () => {
    const previous = announceDay(board(), [
      { playerId: 'p1', cause: DEATH_CAUSES.SELF_DESTRUCT },
      { playerId: 'p8', cause: DEATH_CAUSES.NIGHT_KILL },
    ]).state;
    const state = {
      ...previous,
      day: 2,
      sheriffElectionSuspended: ['p3', 'p4', 'p8'],
      sheriffElectionCandidateIds: ['p3', 'p4', 'p8'],
    };
    let current: GameState = state;
    const voters: string[] = [];
    const withdrew: string[] = [];
    const events: FlowEvent[] = [];
    const result = await runDawn({
      state,
      deaths: [
        { playerId: 'p3', cause: DEATH_CAUSES.NIGHT_KILL },
        { playerId: 'p5', cause: DEATH_CAUSES.WITCH_POISON },
      ],
      minute: 22,
      actions: stubActions({
        wolfBlast: async (_id, resuming) => {
          expect(resuming).toBe(true);
          return false;
        },
        withdraw: async (id) => {
          withdrew.push(id);
          return false;
        },
        vote: async (turn, id, candidates) => {
          expect(turn).toBe('campaign');
          expect(candidates).toEqual(['p3', 'p4']);
          expect(playerOf(current, 'p3').isAlive).toBe(true);
          expect(playerOf(current, 'p5').isAlive).toBe(true);
          voters.push(id);
          return 'p3';
        },
      }),
      observe: (next) => {
        current = next;
      },
      onFlow: async (_state, event) => {
        events.push(event);
      },
    });
    expect(withdrew).toEqual(['p3', 'p4']);
    expect(voters).toEqual(['p2', 'p5', 'p6', 'p7']);
    expect(result.state.sheriffId).toBe('p3');
    expect(playerOf(result.state, 'p3').isAlive).toBe(false);
    expect(events.findIndex((event) => event.key === 'election-result')).toBeLessThan(
      events.findIndex((event) => event.key === 'dawn'),
    );
  });
});
