import { BOARD_IDS } from '../boards/boards';
import { DEALABLE_ROLES } from '../core/roles';
import { gameSkills, type ScenarioId } from './game-skills';

/** 端口会去取的那几个场景，与 ScenarioId 的取值域同一份。 */
const SCENARIOS: readonly ScenarioId[] = [
  'day_speech',
  'vote',
  'night_action',
  'sheriff_decide_order',
  'wolf_team',
  'wolf_discussion',
];

describe('一局要带的技能正文', () => {
  it('每块板子各取到各的公开规则，没有两块撞在同一份上', () => {
    const contents = BOARD_IDS.map((boardId) => gameSkills(boardId).ruleset.content);

    expect(new Set(contents).size).toBe(BOARD_IDS.length);
  });

  it('八张牌各取到各的那一份，没有两张撞在同一份上', () => {
    const skills = gameSkills(BOARD_IDS[0]);
    const contents = DEALABLE_ROLES.map((role) => skills.role(role).content);

    expect(new Set(contents).size).toBe(DEALABLE_ROLES.length);
  });

  it('各场景取到各自的正文，没有两个撞在同一份上', () => {
    const skills = gameSkills(BOARD_IDS[0]);
    const contents = SCENARIOS.map((id) => skills.scenario(id).content);

    expect(new Set(contents).size).toBe(SCENARIOS.length);
  });
});
