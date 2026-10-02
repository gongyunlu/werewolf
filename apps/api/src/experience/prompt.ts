import { EXPERIENCE_PROMPTS, loadPrompt } from '../prompts/catalog';
import { z } from 'zod';
import {
  ExperienceContentSchema,
  ExperienceResultSchema,
  ReviewAnalysisSchema,
  type ExperienceResult,
} from '@werewolf/shared';
import { renderTemplate, type PromptSource, type PromptTemplate } from '../prompts/template';
import type { ExperienceInput } from '../store/experiences';
import { InvalidOutputError } from '../llm/model-port';
import { toolOf } from '../llm/structured-output';

export async function experiencePrompts(source: PromptSource): Promise<PromptTemplate[]> {
  return Promise.all(Object.values(EXPERIENCE_PROMPTS).map((name) => loadPrompt(source, name)));
}
export function experienceRequest(input: ExperienceInput) {
  const variables = {
    identity: JSON.stringify({
      agentId: input.seat.agentId,
      boardId: input.boardId,
      role: input.role,
    }),
    review: ReviewAnalysisSchema.pick({ text: true }).parse(input.review).text,
    evidence: JSON.stringify(
      input.sources.map((source, index) => ({ ...source, id: referenceOf(index) })),
    ),
  };
  return {
    system: renderTemplate(input.prompts[0]!, variables),
    prompt: renderTemplate(input.prompts[1]!, variables),
    prompts: input.prompts.map(({ name, version, source }) => ({ name, version, source })),
    primaryPrompt: EXPERIENCE_PROMPTS.user,
  };
}

const referenceOf = (index: number) => `E${index + 1}`;

/** 工具候选与实际证据共用同一份编号，不能把复盘评价 ID 填进来。 */
export function experienceTool(input: ExperienceInput) {
  const ids = input.sources.map((_, index) => referenceOf(index));
  const schema = ExperienceResultSchema.extend({
    experiences: ids.length
      ? z
          .array(ExperienceContentSchema.extend({ sourceIds: z.array(z.enum(ids)).min(1).max(6) }))
          .max(3)
      : z.array(ExperienceContentSchema).max(0),
  });
  return toolOf(schema, '提炼零至三条个人历史经验，sourceIds 只选原始证据的 E 编号');
}

/** 原答复保留短编号；保存产物时映射回冻结来源，旧调用按原格式恢复。 */
export function resolveExperienceSources(
  input: ExperienceInput,
  result: ExperienceResult,
  shortIds: boolean,
): ExperienceResult {
  const ids = new Map(
    input.sources.map((source, index) => [shortIds ? referenceOf(index) : source.id, source.id]),
  );
  return {
    ...result,
    experiences: result.experiences.map((item) => ({
      ...item,
      sourceIds: item.sourceIds.map((id) => {
        const sourceId = ids.get(id);
        if (!sourceId)
          throw new InvalidOutputError(
            '经验来源不存在',
            shortIds
              ? `sourceIds 必须来自给定原始证据，只能选择 E1 至 E${input.sources.length}；不能使用复盘 D 编号、assessment 或其他内部 ID`
              : 'sourceIds 必须来自给定原始证据',
          );
        return sourceId;
      }),
    })),
  };
}
