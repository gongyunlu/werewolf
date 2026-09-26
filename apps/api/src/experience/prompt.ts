import { z } from 'zod';
import {
  ExperienceContentSchema,
  ExperienceResultSchema,
  ReviewAnalysisSchema,
  type ExperienceResult,
} from '@werewolf/shared';
import {
  assertTemplateContract,
  localPromptSource,
  renderTemplate,
  type PromptSource,
  type PromptTemplate,
} from '../llm/prompt-template';
import type { ExperienceInput } from '../store/experiences';
import { InvalidOutputError } from '../llm/model-port';
import { toolOf } from '../turn/decisions';

export const EXPERIENCE_PROMPTS = {
  system: 'experience/extract-system',
  user: 'experience/extract-user',
} as const;
export const LOCAL_EXPERIENCE_PROMPTS = localPromptSource({
  [EXPERIENCE_PROMPTS.system]: `你在赛后为一名持久身份的狼人杀玩家提炼个人经验。只提炼有原始证据支持、对未来有参考价值的经验，允许返回零条，不要凑数。复盘是可讨论的意见，不是权威事实，必须结合原始证据。
区分行动当时实际可见的信息、出局后旁观和赛后才知道的信息。at_action 来源只证明对应行动时可见，不能倒推到更早的行动；post_game 来源是赛后材料，不证明玩家当时知道或出局后看见。没有旁观记录，不得虚构旁观经历。
可以从赛后身份和结果学习，但不能把后见信息写成当时的依据。历史座位、身份、发言、关系仅是旧局背景，不能写成未来对局事实。经验正文应写可被新证据推翻的参考做法及适用条件，当前规则与证据始终优先。
允许不同打法、判断偏差和改变立场，不打分、不按裁判偏好统一策略。硬约束只关注信息视角和底层规则、行动时序；不要发明技能、资格或结算规则。
sourceIds 只能选择本次原始证据的 E 编号，每条至少引用一个原始来源。复盘正文中的 D 编号只是意见的阅读标记，不能作为经验来源；不要引用评价、追踪或其他内部 ID。使用中文，通过规定工具返回结果。`,
  [EXPERIENCE_PROMPTS.user]: `来源身份、板子与角色（只属于历史对局）：\n{{identity}}\n玩家复盘（主观意见）：\n{{review}}\n原始证据及可知边界：\n{{evidence}}\n最多保存三条，每条说明适用条件。没有新经验时 experiences 返回空数组，reason 说明原因。`,
});

export async function experiencePrompts(source: PromptSource): Promise<PromptTemplate[]> {
  return Promise.all(
    Object.values(EXPERIENCE_PROMPTS).map(async (name) => {
      const template = source.strict
        ? await source.load(name)
        : await source.load(name).catch(() => LOCAL_EXPERIENCE_PROMPTS.load(name));
      assertTemplateContract(
        template,
        name === EXPERIENCE_PROMPTS.user ? ['identity', 'review', 'evidence'] : [],
      );
      return template;
    }),
  );
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
