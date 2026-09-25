import { DEATH_CAUSES, FACTIONS, ROLES } from '@werewolf/shared';
import { makeState, playerOf, stubActions, withRoles } from '../testing/fixtures';
import { announceDay, type NightDeath } from './day/announce';
import { triggerDeathSkills } from './deaths';
import type { DealableRole } from './roles';
import type { GameState } from './state';
import { checkWin } from './win';

/** 按给的牌摆一局，再照死讯把人放倒——传进 triggerDeathSkills 的必须是已经出局的那批人。 */
function boardAfter(
  roles: Readonly<Record<string, DealableRole>>,
  deaths: readonly NightDeath[],
  playerCount = 6,
): GameState {
  return announceDay(withRoles(makeState(playerCount), roles), deaths).state;
}

/**
 * 两条连锁用例共用的牌面：死者之外神职、平民、狼各留一个活口。
 * 少一个，枪一响就屠了边，胜负当场定下来，下一问根本轮不到。
 */
const CHAIN_BOARD: Readonly<Record<string, DealableRole>> = {
  p1: ROLES.HUNTER,
  p2: ROLES.WOLF_KING,
  p3: ROLES.SEER,
  p6: ROLES.WEREWOLF,
};

describe('出局技能连锁', () => {
  it('猎人被放逐，开枪带走狼王，狼王接着带走一个', async () => {
    const deaths: NightDeath[] = [{ playerId: 'p1', cause: DEATH_CAUSES.EXECUTION }];
    const state = boardAfter(CHAIN_BOARD, deaths);
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
    const state = boardAfter(CHAIN_BOARD, deaths);
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
    // 传五个人：六人局留不下活口，链条会撞上屠边提前收口，验不出「不设上限」。
    const state = boardAfter(
      {
        p1: ROLES.HUNTER,
        p2: ROLES.WOLF_KING,
        p3: ROLES.HUNTER,
        p4: ROLES.WOLF_KING,
        p7: ROLES.SEER,
        p8: ROLES.WEREWOLF,
      },
      deaths,
      8,
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
    const state = boardAfter(
      {
        p1: ROLES.HUNTER,
        p3: ROLES.HUNTER,
        p4: ROLES.SEER,
        p5: ROLES.WOLF_KING,
        p6: ROLES.WEREWOLF,
      },
      deaths,
    );
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

  it('带走最后一张平民就分出胜负，同批剩下的不再问', async () => {
    // p4 是场上唯一的平民：狼王把他带走就屠完边了。
    const deaths: NightDeath[] = [
      { playerId: 'p1', cause: DEATH_CAUSES.EXECUTION },
      { playerId: 'p2', cause: DEATH_CAUSES.NIGHT_KILL },
    ];
    const state = boardAfter(
      {
        p1: ROLES.WOLF_KING,
        p2: ROLES.HUNTER,
        p3: ROLES.SEER,
        p5: ROLES.SEER,
        p6: ROLES.WEREWOLF,
      },
      deaths,
    );
    // 没配 hunterShot：胜负已经分出来了，这一问是白花的。
    const actions = stubActions({ wolfKingShot: async () => 'p4' });

    const after = await triggerDeathSkills(state, deaths, actions);

    expect(playerOf(after, 'p4').deathCause).toBe(DEATH_CAUSES.WOLF_KING_SHOT);
    expect(playerOf(after, 'p2').deathCause).toBe(DEATH_CAUSES.NIGHT_KILL);
  });

  it('带走最后一个神职就判狼人胜，猎人那一枪不再问', async () => {
    // p2 是场上唯一的神职，也是能把最后一狼打死的那个人：狼王把他带走就屠完了神边，
    // 判定点当场定下狼人胜，队列里排着的猎人那一枪不再问；改动前那一枪会打死最后一狼，
    // 胜负就翻成好人胜——顺序即规则，先分出来的那一边说了算。
    const deaths: NightDeath[] = [{ playerId: 'p1', cause: DEATH_CAUSES.EXECUTION }];
    const state = boardAfter({ p1: ROLES.WOLF_KING, p2: ROLES.HUNTER, p3: ROLES.WEREWOLF }, deaths);
    // 没配 hunterShot：胜负已经分出来了，这一问是白花的。
    const actions = stubActions({ wolfKingShot: async () => 'p2' });

    const after = await triggerDeathSkills(state, deaths, actions);

    expect(playerOf(after, 'p2').deathCause).toBe(DEATH_CAUSES.WOLF_KING_SHOT);
    expect(playerOf(after, 'p3').isAlive).toBe(true);
    expect(checkWin(after)).toBe(FACTIONS.WEREWOLF);
  });

  it('死因不在白名单里就不问，技能带不走人', async () => {
    const deaths: NightDeath[] = [{ playerId: 'p1', cause: DEATH_CAUSES.WITCH_POISON }];
    const state = boardAfter({ p1: ROLES.HUNTER }, deaths);

    // stubActions 没配 hunterShot，真问到就会失败。
    expect(await triggerDeathSkills(state, deaths, stubActions())).toEqual(state);
  });

  it('猎人被白狼王带走，照样开枪', async () => {
    const deaths: NightDeath[] = [{ playerId: 'p1', cause: DEATH_CAUSES.WHITE_WOLF_TAKE }];
    const state = boardAfter({ p1: ROLES.HUNTER }, deaths);
    const actions = stubActions({ hunterShot: async () => 'p2' });

    const after = await triggerDeathSkills(state, deaths, actions);

    expect(playerOf(after, 'p2')).toMatchObject({
      isAlive: false,
      deathCause: DEATH_CAUSES.HUNTER_SHOT,
    });
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
