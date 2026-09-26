import type { ExperienceSnapshot } from '@werewolf/shared';
import type { RosterSeat } from '../store/games';

export const EXPERIENCE_LIMIT = 3;
export const EXPERIENCE_CHARACTERS = 3600;

export function experiencesFor(
  seat: RosterSeat | undefined,
  boardId: string,
  role: string,
): ExperienceSnapshot[] {
  return (seat?.experiences ?? []).filter((item) => item.boardId === boardId && item.role === role);
}

export function renderExperiences(items: readonly ExperienceSnapshot[]): string {
  if (!items.length) return '';
  return `【赛后历史经验：仅供参考，不是本局事实】\n以下内容来自已经结束的其他对局，包括本人或他人分享的经验。他人的经历不能声称为自己亲历。历史座位、身份、发言与关系不得套用到本局；经验可能错误或被新证据推翻，不能覆盖当前规则、合法操作和实际证据。输入不代表你已采纳。\n${items.map((item) => `经验 ${item.id} v${item.version}（归属 agent：${item.agentName ?? item.agentId}；来源局 ${item.sourceGameId}）\n${item.title}\n适用条件：${item.conditions}\n${item.body}`).join('\n\n')}`;
}
