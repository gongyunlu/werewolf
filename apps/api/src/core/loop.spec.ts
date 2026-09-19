import { DEATH_CAUSES, FACTIONS, ROLES } from '@werewolf/shared';
import type { RandomSource } from '../boards/deal';
import { ballotOf, makeState, playerOf, stubActions, withRoles } from '../testing/fixtures';
import { runGame } from './loop';

/** 狼队刀口一致时用不上，只为凑接口。 */
const random: RandomSource = () => 0;

describe('推到终局', () => {
  it('最后一狼夜里被毒死，天亮公布完就结束，白天不用走', async () => {
    const state = withRoles(makeState(6), {
      p1: ROLES.WEREWOLF,
      p2: ROLES.SEER,
      p3: ROLES.WITCH,
      p4: ROLES.GUARD,
    });
    // 没配 runForSheriff：白天真走起来就会失败。
    const actions = stubActions({
      wolfProposal: async () => 'p5',
      guardProtect: async () => null,
      seerCheck: async () => 'p1',
      witchDecision: async () => ({ kind: 'poison', targetId: 'p1' }),
    });

    const result = await runGame({ state, actions, random, minuteOf: () => 22 });

    expect(result.winner).toBe(FACTIONS.GOOD);
    expect(playerOf(result.state, 'p1').isAlive).toBe(false);
    expect(result.state.day).toBe(1);
    expect(result.state.sheriffId).toBeNull();
  });

  it('放逐狼王后他带走最后一个平民，狼人屠民获胜', async () => {
    const state = withRoles(makeState(6, false), {
      p1: ROLES.WOLF_KING,
      p2: ROLES.WEREWOLF,
      p3: ROLES.HUNTER,
      p6: ROLES.SEER,
    });
    const actions = stubActions({
      wolfProposal: async () => 'p4',
      seerCheck: async () => 'p1',
      wolfBlast: async () => false,
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      vote: ballotOf({ p1: 'p1', p2: 'p1', p3: 'p1', p5: 'p1', p6: 'p1' }),
      wolfKingShot: async () => 'p5',
    });

    const result = await runGame({ state, actions, random, minuteOf: () => 22 });

    expect(result.winner).toBe(FACTIONS.WEREWOLF);
    expect(playerOf(result.state, 'p1')).toMatchObject({ deathCause: DEATH_CAUSES.EXECUTION });
    expect(playerOf(result.state, 'p5')).toMatchObject({
      isAlive: false,
      deathCause: DEATH_CAUSES.WOLF_KING_SHOT,
    });
    expect(result.state.day).toBe(1);
  });

  it('放逐狼王带走警长：警徽当场结掉，候选名单里还有下半夜要死的人', async () => {
    // 关掉竞选、把警徽预置给 p1：这条要看的是放逐技能连锁之后的收尾，不是警长的来路。
    const state = withRoles(
      { ...makeState(6, false), sheriffId: 'p1' },
      {
        p2: ROLES.WOLF_KING,
        p3: ROLES.WEREWOLF,
        p5: ROLES.HUNTER,
        p6: ROLES.SEER,
      },
    );
    let night = 0;
    const asked: string[][] = [];
    const actions = stubActions({
      wolfProposal: async () => {
        night += 1;
        return night === 1 ? 'p6' : 'p4';
      },
      seerCheck: async () => 'p2',
      wolfBlast: async () => false,
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      vote: ballotOf({ p1: 'p2', p2: 'p2', p3: 'p2', p4: 'p2', p5: 'p2' }),
      wolfKingShot: async () => 'p1',
      decideBadge: async (_sheriffId, candidates) => {
        asked.push([...candidates]);
        return { kind: 'transfer', toId: 'p5' };
      },
    });

    const result = await runGame({ state, actions, random, minuteOf: () => 22 });

    expect(result.winner).toBe(FACTIONS.WEREWOLF);
    // p4 当晚就被狼刀，他还在候选名单里，说明移交算在放逐那一刻，没等到第二天早晨。
    expect(asked).toEqual([['p3', 'p4', 'p5']]);
    expect(result.state.sheriffId).toBe('p5');
  });

  it('被放逐的狼王兼警长：先开枪带走人，再交警徽', async () => {
    // 关掉竞选、把警徽预置给 p1：这条看的是死后技能与警徽的先后。
    const state = withRoles(
      { ...makeState(6, false), sheriffId: 'p1' },
      {
        p1: ROLES.WOLF_KING,
        p2: ROLES.WEREWOLF,
        p3: ROLES.HUNTER,
        p6: ROLES.SEER,
      },
    );
    let night = 0;
    const asked: string[][] = [];
    const actions = stubActions({
      wolfProposal: async () => {
        night += 1;
        return night === 1 ? 'p6' : 'p3';
      },
      seerCheck: async () => 'p2',
      wolfBlast: async () => false,
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      vote: ballotOf({ p1: 'p1', p2: 'p1', p3: 'p1', p4: 'p1', p5: 'p1' }),
      wolfKingShot: async () => 'p4',
      decideBadge: async (sheriffId, candidates) => {
        asked.push([sheriffId, ...candidates]);
        return { kind: 'transfer', toId: 'p5' };
      },
    });

    const result = await runGame({ state, actions, random, minuteOf: () => 22 });

    // p4 是先挨了狼王那一枪的，他不在候选名单里——警徽排在技能之后，不是之前。
    expect(asked).toEqual([['p1', 'p2', 'p3', 'p5']]);
    expect(result.state.sheriffId).toBe('p5');
  });

  it('放逐最后一狼、他又是警长：对局当场终结，警徽不再动', async () => {
    const state = withRoles(
      { ...makeState(6, false), sheriffId: 'p1' },
      {
        p1: ROLES.WEREWOLF,
        p2: ROLES.SEER,
        p3: ROLES.HUNTER,
      },
    );
    // 没配 decideBadge：终局了还去问警徽给谁，就会在这里失败。
    const actions = stubActions({
      wolfProposal: async () => 'p6',
      seerCheck: async () => 'p1',
      wolfBlast: async () => false,
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      chooseSpeechSide: async () => 'right',
      vote: ballotOf({ p1: 'p1', p2: 'p1', p3: 'p1', p4: 'p1', p5: 'p1' }),
    });

    const result = await runGame({ state, actions, random, minuteOf: () => 22 });

    expect(result.winner).toBe(FACTIONS.GOOD);
    expect(playerOf(result.state, 'p1')).toMatchObject({ deathCause: DEATH_CAUSES.EXECUTION });
    // 警徽留在已经出局的 p1 身上：交给谁都不影响胜负，不为它多问一次。
    expect(result.state.sheriffId).toBe('p1');
  });

  it('第一天平安夜又没人出局，天数推进到第二天接着打', async () => {
    const state = withRoles(makeState(6, false), {
      p1: ROLES.WEREWOLF,
      p2: ROLES.SEER,
      p3: ROLES.WITCH,
      p4: ROLES.GUARD,
    });
    let night = 0;
    const actions = stubActions({
      wolfProposal: async () => {
        night += 1;
        return night === 1 ? null : 'p5';
      },
      guardProtect: async () => null,
      seerCheck: async () => (night === 1 ? 'p1' : 'p3'),
      witchDecision: async () =>
        night === 1 ? { kind: 'none' } : { kind: 'poison', targetId: 'p1' },
      wolfBlast: async () => false,
      speak: async (turn, playerId) => `${turn}:${playerId}`,
      vote: async () => null,
    });

    const result = await runGame({ state, actions, random, minuteOf: () => 22 });

    expect(result.state.day).toBe(2);
    expect(result.winner).toBe(FACTIONS.GOOD);
    expect(playerOf(result.state, 'p1').isAlive).toBe(false);
    expect(playerOf(result.state, 'p5')).toMatchObject({
      isAlive: false,
      deathDay: 2,
      deathCause: DEATH_CAUSES.NIGHT_KILL,
    });
    // 两次入夜、一次死讯结算、一次白天：序号跨天一路往上涨，不按天重置。
    expect(result.state.phaseInstanceId).toBe('node/4/night');
  });
});
