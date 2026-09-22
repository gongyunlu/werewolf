import type { BoardId } from '../boards/boards';
import type { DealableRole } from '../core/roles';
import { loadSkill, type Skill } from './skill-loader';

/** 场景正文的名字，与 skills/v1/scenarios 下的目录名一一对应。 */
export type ScenarioId = 'day_speech' | 'vote' | 'night_action' | 'sheriff_decide_order';

/** 一局要用的全部正文。开跑前按板子取一次，整局不再变。 */
export interface GameSkills {
  /** 板子那份：这局公开的规则与流程。 */
  ruleset: Skill;
  /** 按角色取。 */
  role: (role: DealableRole) => Skill;
  /** 按场景取。 */
  scenario: (id: ScenarioId) => Skill;
}

/** 按板子取齐一局的正文。名字就是取值域里的串，路径直接拼得出来，不另做映射。 */
export function gameSkills(boardId: BoardId): GameSkills {
  return {
    ruleset: loadSkill(`rulesets/${boardId}`),
    role: (role) => loadSkill(`roles/${role}`),
    scenario: (id) => loadSkill(`scenarios/${id}`),
  };
}
