import { ROLES } from '@werewolf/shared';
import { makeState, playerOf, withRoles } from './fixtures';

/** 夹具自己也得有人看着：写错 id 若静默不管，用例会在不是它摆的局面里跑，还照样显示通过。 */
describe('夹具写错 id 时当场炸', () => {
  it('改角色的人不在局内就抛错', () => {
    expect(() => withRoles(makeState(6), { p9: ROLES.WEREWOLF })).toThrow('局内没有 p9');
  });

  it('取一个不在局内的人就抛错', () => {
    expect(() => playerOf(makeState(6), 'p9')).toThrow('局内没有 p9');
  });
});
