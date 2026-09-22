import { phaseInstanceId, type ActionScope } from './identity';
import { stageRandom } from './random';

function scopeOf(ordinal: number, nodeName: string, gameId = 'g1'): ActionScope {
  return { gameId, phaseInstanceId: phaseInstanceId(ordinal, nodeName) };
}

/** 从这一格里连着抽几次。 */
function draw(scope: ActionScope, times = 6): number[] {
  const random = stageRandom(scope);
  return Array.from({ length: times }, () => random());
}

describe('按格现算的随机流', () => {
  it('同一格取两次是同一串', () => {
    // 恢复会重进同一格，抽出来的数变了刀口就跟着变，同一局重跑一遍就不是同一场对局了。
    expect(draw(scopeOf(1, 'night'))).toEqual(draw(scopeOf(1, 'night')));
  });

  it('换一格就是另一串', () => {
    const base = draw(scopeOf(1, 'night'));

    expect(draw(scopeOf(2, 'night'))).not.toEqual(base);
    expect(draw(scopeOf(1, 'day'))).not.toEqual(base);
    expect(draw(scopeOf(1, 'night', 'g2'))).not.toEqual(base);
  });

  it('抽出来的数落在 [0, 1)：取并列的人要用它当倍数', () => {
    const random = stageRandom(scopeOf(7, 'night'));

    for (let time = 0; time < 200; time += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('两个格子各抽各的，中间抽别的不会岔开', () => {
    const random = stageRandom(scopeOf(1, 'night'));
    const other = stageRandom(scopeOf(2, 'night'));
    const taken: number[] = [];

    for (let time = 0; time < 3; time += 1) {
      other();
      taken.push(random());
    }

    // 两条流各数各的：中间插进来抽几下，这一格抽到的还是它自己那一串。
    expect(taken).toEqual(draw(scopeOf(1, 'night'), 3));
  });
});
