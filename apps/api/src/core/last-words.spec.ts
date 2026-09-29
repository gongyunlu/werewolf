import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import { makeState, stubActions, withRoles } from '../testing/fixtures';
import { nodeNameOf, phaseInstanceId } from './identity';
import { runGame } from './loop';
import { patchPlayer } from './state';

describe('首夜遗言', () => {
  it.each([1, 2])('第 %s 夜死者在死亡技能和交徽之后，仅首夜发表遗言', async (day) => {
    let state = withRoles(
      { ...makeState(8), day, sheriffId: 'p5', phaseInstanceId: phaseInstanceId(3, 'deathSkills') },
      { p1: ROLES.WEREWOLF, p2: ROLES.WEREWOLF, p3: ROLES.HUNTER, p6: ROLES.SEER },
    );
    const deaths = [
      { playerId: 'p5', cause: DEATH_CAUSES.WITCH_POISON },
      { playerId: 'p3', cause: DEATH_CAUSES.NIGHT_KILL },
    ];
    for (const death of deaths) {
      state = patchPlayer(state, death.playerId, {
        isAlive: false,
        deathDay: day,
        deathCause: death.cause,
      });
    }
    let current = state;
    const order: string[] = [];
    const actions = stubActions({
      hunterShot: async () => {
        order.push('开枪');
        return 'p4';
      },
      decideBadge: async () => {
        order.push('交徽');
        return { kind: 'transfer', toId: 'p6' };
      },
      speak: async (round, id, speakers) => {
        expect(round).toBe('last_words');
        expect(speakers).toEqual(['p3', 'p5']);
        expect(current.sheriffId).toBe('p6');
        expect(current.players.find((p) => p.id === 'p4')!.isAlive).toBe(false);
        order.push(id);
        return `${id} 的遗言。`;
      },
    });
    await expect(
      runGame({
        state,
        actions,
        minuteOf: () => 0,
        resume: { state, phaseInstanceId: state.phaseInstanceId, input: { deaths } },
        observe: (next) => {
          current = next;
        },
        onStage: async (anchor) => {
          if (nodeNameOf(anchor.phaseInstanceId) === 'day') throw new Error('到白天发言为止');
        },
      }),
    ).rejects.toThrow('到白天发言为止');
    expect(order).toEqual(day === 1 ? ['开枪', '交徽', 'p3', 'p5'] : ['开枪', '交徽']);
  });
});
