import { ExperienceAuditSchema, type AgentExperience } from '@werewolf/shared';
import type { GameStores } from '../store/stores';

const normalized = (value: string) => value.replace(/[\s\p{P}]/gu, '').toLowerCase();

/** 范围重叠只提示核对，不把措辞相似当成策略矛盾。 */
export async function experienceAudit(stores: GameStores, item: AgentExperience) {
  const [generation, candidates] = await Promise.all([
    stores.experiences.findGeneration(item.generationId),
    stores.experiences.related(item.boardId, item.role),
  ]);
  const related = candidates
    .filter((other) => {
      if (other.id === item.id) return false;
      if (!item.actionTypes || !other.actionTypes) return true;
      if (!item.actionTypes.some((type) => other.actionTypes!.includes(type))) return false;
      return (
        !(item.firstDayOnly && (other.minDay ?? 1) > 1) &&
        !(other.firstDayOnly && (item.minDay ?? 1) > 1)
      );
    })
    .map((other) => ({
      experience: other,
      reason:
        normalized(item.body) === normalized(other.body) &&
        normalized(item.conditions) === normalized(other.conditions) &&
        normalized(item.exclusions ?? '') === normalized(other.exclusions ?? '')
          ? ('duplicate' as const)
          : ('overlapping_scope' as const),
    }));
  return ExperienceAuditSchema.parse({
    experience: item,
    sources: generation!.state.input!.sources.filter((source) =>
      item.sourceIds.includes(source.id),
    ),
    related,
  });
}
