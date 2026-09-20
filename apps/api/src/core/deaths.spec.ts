import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import { makeState, playerOf, stubActions, withRoles } from '../testing/fixtures';
import { announceDay, type NightDeath } from './day/announce';
import { triggerDeathSkills } from './deaths';
import type { DealableRole } from './roles';
import type { GameState } from './state';

/** 按给的牌摆一局，再照死讯把人放倒——传进 triggerDeathSkills 的必须是已经出局的那批人。 */
function boardAfter(
  roles: Readonly<Record<string, DealableRole>>,
  deaths: readonly NightDeath[],
): GameState {
  return announceDay(withRoles(makeState(6), roles), deaths).state;
}

describe('出局技能连锁', () => {
  it('猎人被放逐，开枪带走狼王，狼王接着带走一个', async () => {
    const deaths: NightDeath[] = [{ playerId: 'p1', cause: DEATH_CAUSES.EXECUTION }];
    const state = boardAfter({ p1: ROLES.HUNTER, p2: ROLES.WOLF_KING }, deaths);
    const actions = stubActions({
      hunterShot: async () => 'p2',
      wolfKingShot: async () => 'p3',
    });

    const after = await triggerDeathSkills(state, deaths, actions);

    expect(playerOf(after, 'p2')).toMatchObject({
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.HUNTER_SHOT,
    });
    expect(playerOf(after, 'p3')).toMatchObject({
      isAlive: false,
      deathDay: 1,
      deathCause: DEATH_CAUSES.WOLF_KING_SHOT,
    });
  });

  it('连锁里前一个刚出局的人，后一问看得见', async () => {
    const deaths: NightDeath[] = [{ playerId: 'p1', cause: DEATH_CAUSES.EXECUTION }];
    const state = boardAfter({ p1: ROLES.HUNTER, p2: ROLES.WOLF_KING }, deaths);
    let observed: string | null = null;
    let seenAtKing: string | null = null;
    const actions = stubActions({
      hunterShot: async () => 'p2',
      wolfKingShot: async () => {
        seenAtKing = observed;
        return 'p3';
      },
    });

    await triggerDeathSkills(state, deaths, actions, (next) => {
      observed = next.players
        .filter((player) => !player.isAlive)
        .map((player) => player.id)
        .join(',');
    });

    // 狼王带人那一问得看见猎人先出的局：不给就是拿着猎人还活着的那份局面在答。
    expect(seenAtKing).toBe('p1,p2');
  });

  it('连锁不设上限，能带人的牌一路传下去', async () => {
    const deaths: NightDeath[] = [{ playerId: 'p1', cause: DEATH_CAUSES.EXECUTION }];
    const state = boardAfter(
      { p1: ROLES.HUNTER, p2: ROLES.WOLF_KING, p3: ROLES.HUNTER, p4: ROLES.WOLF_KING },
      deaths,
    );
    const actions = stubActions({
      hunterShot: async (hunterId) => (hunterId === 'p1' ? 'p2' : 'p4'),
      wolfKingShot: async (wolfKingId) => (wolfKingId === 'p2' ? 'p3' : 'p5'),
    });

    const after = await triggerDeathSkills(state, deaths, actions);

    // p1 开枪打 p2，p2 带走 p3，p3 再打 p4，p4 再带 p5：四层。
    expect(['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => playerOf(after, id).isAlive)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(playerOf(after, 'p5').deathCause).toBe(DEATH_CAUSES.WOLF_KING_SHOT);
  });

  it('同一批死者按死讯顺序挨个问', async () => {
    const deaths: NightDeath[] = [
      { playerId: 'p1', cause: DEATH_CAUSES.NIGHT_KILL },
      { playerId: 'p3', cause: DEATH_CAUSES.NIGHT_KILL },
    ];
    const state = boardAfter({ p1: ROLES.HUNTER, p3: ROLES.HUNTER, p5: ROLES.WOLF_KING }, deaths);
    const asked: string[] = [];
    const actions = stubActions({
      hunterShot: async (hunterId) => {
        asked.push(hunterId);
        return hunterId === 'p1' ? 'p5' : null;
      },
      wolfKingShot: async () => null,
    });

    const after = await triggerDeathSkills(state, deaths, actions);

    expect(asked).toEqual(['p1', 'p3']);
    // p5 是被 p1 带走的狼王，他也要被问一次，只是选了不带人。
    expect(playerOf(after, 'p5')).toMatchObject({
      isAlive: false,
      deathCause: DEATH_CAUSES.HUNTER_SHOT,
    });
  });

  it('死因不在白名单里就不问，技能带不走人', async () => {
    const deaths: NightDeath[] = [{ playerId: 'p1', cause: DEATH_CAUSES.WITCH_POISON }];
    const state = boardAfter({ p1: ROLES.HUNTER }, deaths);

    // stubActions 没配 hunterShot，真问到就会失败。
    expect(await triggerDeathSkills(state, deaths, stubActions())).toEqual(state);
  });

  it('不是技能牌的人出局，什么都不问', async () => {
    const deaths: NightDeath[] = [{ playerId: 'p1', cause: DEATH_CAUSES.NIGHT_KILL }];
    const state = boardAfter({}, deaths);

    expect(await triggerDeathSkills(state, deaths, stubActions())).toEqual(state);
  });

  it('猎人放弃开枪，就只有他自己出局', async () => {
    const deaths: NightDeath[] = [{ playerId: 'p1', cause: DEATH_CAUSES.NIGHT_KILL }];
    const state = boardAfter({ p1: ROLES.HUNTER }, deaths);
    const actions = stubActions({ hunterShot: async () => null });

    const after = await triggerDeathSkills(state, deaths, actions);

    expect(after.players.filter((player) => !player.isAlive).map((player) => player.id)).toEqual([
      'p1',
    ]);
  });

  it('死讯里的玩家不在局内就抛错', async () => {
    const deaths: NightDeath[] = [{ playerId: 'p9', cause: DEATH_CAUSES.NIGHT_KILL }];

    await expect(triggerDeathSkills(makeState(6), deaths, stubActions())).rejects.toThrow(
      '死讯里的玩家不在局内：p9',
    );
  });
});
