import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import { makeState, playerOf, stubActions, withRoles } from '../../testing/fixtures';
import type { FlowEvent } from '../flow';
import type { GameState } from '../state';
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

  it('白狼王带走夜间待死猎人，即时出局并从夜间名单移除', async () => {
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
      onFlow: async (state, event) => {
        events.push(event);
        if (event.key === 'campaign-blast-take') {
          expect(playerOf(state, 'p4')).toMatchObject({
            isAlive: false,
            deathCause: DEATH_CAUSES.WHITE_WOLF_TAKE,
          });
        }
      },
    });
    expect(result.deaths).toEqual([]);
    expect(events.find((event) => event.key === 'dawn')?.text).toBe('昨晚没有其他玩家倒牌。');
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
