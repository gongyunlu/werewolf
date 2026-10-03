import { loadPrompt, TURN_PROMPT_NAMES, type TurnPromptName } from '../prompts/catalog';
import { z } from 'zod';
import { renderTemplate, type PromptSource, type PromptSourceKind } from '../prompts/template';
import type { TurnContext } from './request';
import { renderExperiences } from '../experience/selection';
import { renderKnowledge } from '../knowledge/render';

/** 质疑者的回答，形状固定，不跟着行动类型变。提示词与解析共用这一份。 */
export const CRITIQUE_SCHEMA = z.object({ accept: z.boolean(), issues: z.string() });

const CRITIQUE_SHAPE = z.toJSONSchema(CRITIQUE_SCHEMA) as Record<string, unknown>;

/** 一段渲染好的提示词，连同它出自哪条模板。 */
export interface RenderedPrompt {
  template: TurnPromptName;
  /** 平台版本号；本地兜底那份是 null。 */
  version: number | null;
  source: PromptSourceKind;
  text: string;
}

/** 一次行动问出去的那一对。 */
export interface RenderedTurn {
  system: RenderedPrompt;
  user: RenderedPrompt;
  experiences?: TurnContext['experiences'];
  knowledge?: TurnContext['knowledge'];
}

/** 生成这一次行动的结果。 */
export async function renderGenerate(
  source: PromptSource,
  context: TurnContext,
  schemaJson: Record<string, unknown> | null,
): Promise<RenderedTurn> {
  const [system, user] = await Promise.all([
    renderPart(source, TURN_PROMPT_NAMES.generateSystem, identityOf(context), context.skill),
    renderPart(source, TURN_PROMPT_NAMES.generateUser, briefOf(context, schemaJson)),
  ]);

  return { system, user, experiences: context.experiences, knowledge: context.knowledge };
}

/**
 * 独立质疑。
 * 只给任务、草稿和板子规则，不给生成时的角色策略与思考过程。
 * 复核需要知道本局规则，但不应重新制定玩家策略。
 * 可选项得给：「目标必须在候选里」正是它要判的形式之一，不给就没法判。
 * shapeJson 给的是工具那一份，与草稿同一层；给内层 schema 的话，裹着的那层壳会被判成形式错误。
 */
export async function renderCritique(
  source: PromptSource,
  context: TurnContext,
  draft: string,
  shapeJson: Record<string, unknown> | null,
): Promise<RenderedTurn> {
  const [system, user] = await Promise.all([
    renderPart(source, TURN_PROMPT_NAMES.critiqueSystem, {}, context.skill.slice(0, 1)),
    renderPart(source, TURN_PROMPT_NAMES.critiqueUser, {
      day: String(context.day),
      seatNo: String(context.actor.seatNo),
      role: context.actor.role,
      task: context.task,
      facts: factsOf(context),
      options: optionsOf(context),
      draft,
      shape: shapeOf(shapeJson),
      output: outputOf(CRITIQUE_SHAPE),
    }),
  ]);

  return { system, user, experiences: context.experiences, knowledge: context.knowledge };
}

/** 核对质疑意见并校正原稿，不附加重新制定策略的指南。 */
export async function renderRevise(
  source: PromptSource,
  context: TurnContext,
  draft: string,
  issues: string,
  schemaJson: Record<string, unknown> | null,
): Promise<RenderedTurn> {
  const [system, user] = await Promise.all([
    renderPart(
      source,
      TURN_PROMPT_NAMES.reviseSystem,
      identityOf(context),
      context.skill.slice(0, 1),
    ),
    renderPart(source, TURN_PROMPT_NAMES.reviseUser, {
      ...briefOf(context, schemaJson),
      draft,
      issues,
    }),
  ]);

  return { system, user, experiences: context.experiences, knowledge: context.knowledge };
}

/**
 * 把窗口外那一整天的发言折成摘要。
 *
 * 不带技能正文：这一问要的不是怎么打狼人杀，是把别人说过的话压短，
 * 带上去只会把角色的立场掺进一份本该中立的笔记里。
 *
 * @param source 提示词的来处
 * @param input 折哪一天、哪个渠道、有谁说了什么，以及交上来要什么形状
 */
export async function renderSummary(
  source: PromptSource,
  input: {
    day: number;
    /** 频道的人话名，写进题面。 */
    channel: string;
    /** 这一天的发言，一行一段，每行已带说话人的座位号。 */
    speeches: readonly string[];
    /** 要交出几条，与说话的人数一致。 */
    count: number;
    schemaJson: Record<string, unknown>;
  },
): Promise<RenderedTurn> {
  const [system, user] = await Promise.all([
    renderPart(source, TURN_PROMPT_NAMES.summarySystem, {}),
    renderPart(source, TURN_PROMPT_NAMES.summaryUser, {
      day: String(input.day),
      channel: input.channel,
      speeches: input.speeches.join('\n'),
      count: String(input.count),
      output: outputOf(input.schemaJson),
    }),
  ]);

  return { system, user };
}

/**
 * 取一条模板渲染好。平台那条读不到就退到本地那份，落在哪一份记在 RenderedPrompt.source 里。
 *
 * 逐条退而不整局换源：提示词改成即用即取之后，同一局的两段本来就可能取到不同版本，
 * 「整局要么全平台要么全本地」这条保证在取用方式那一头已经放开了，这一层再维持它没有意义。
 *
 * skill 是拼在正文后面的技能正文：它不走模板变量，平台那边不托管它，改它不必动模板。
 * 模板的正文与技能正文都进这个 RenderedPrompt，交出去的 text 就是最终发出去的那一段。
 */
async function renderPart(
  source: PromptSource,
  name: TurnPromptName,
  variables: Record<string, string>,
  skill: readonly string[] = [],
): Promise<RenderedPrompt> {
  const template = await loadPrompt(source, name);
  const text = renderTemplate(template, variables);

  return {
    template: name,
    version: template.version,
    source: template.source,
    text: blocks([
      text,
      ...skill,
      name === TURN_PROMPT_NAMES.generateSystem
        ? '只分析影响当前选择的信息，不反复推翻同一判断或穷举多轮分支。策略可以有风险，操作必须符合当前合法窗口。'
        : '',
      name === TURN_PROMPT_NAMES.critiqueSystem
        ? '审核仅限视角泄露和底层规则、流程错误，不审核策略偏好、推理完整度或措辞。只列有明确依据的冲突，不重写草稿。'
        : '',
      name.endsWith('-system')
        ? '请使用简体中文思考和回答，推理过程也使用简体中文。工具名、JSON 字段名和约定的枚举值保持原样。'
        : '',
    ]),
  };
}

function identityOf(context: TurnContext): Record<string, string> {
  return { seatNo: String(context.actor.seatNo), role: context.actor.role };
}

/** 局面与任务。输出格式由 outputOf 单独给，不混进这一段。 */
function briefOf(
  context: TurnContext,
  schemaJson: Record<string, unknown> | null,
): Record<string, string> {
  return {
    day: String(context.day),
    facts: factsOf(context),
    task: context.task,
    options: optionsOf(context),
    output: outputOf(schemaJson),
  };
}

function factsOf(context: TurnContext): string {
  // 块之间空一行，免得上一块的最后一条跟下一块的标题连成一串。
  const rendered = context.visible.map((block) =>
    [
      `【${block.title}】`,
      ...(block.title === '狼队商议'
        ? [
            '仅狼队可见；其中计划不表示已公开或已执行。公开配合须核对本轮发言顺序与队友已经公开说过的内容。',
          ]
        : []),
      ...(block.title === '法官私密告知'
        ? [
            '仅向具备资格的玩家告知，不代表全场已知。可据此制定战术；公开表达先分清所扮身份能知道的依据，避免无意暴露，仍可有意造假或隐瞒。',
          ]
        : []),
      ...block.lines.map(factLine),
    ].join('\n'),
  );

  const previous = context.previousJudgment;
  return blocks([
    previous
      ? `【你此前的个人判断（不是已确认事实）】\n形成于第 ${previous.day} 天日终。\n${previous.assessment}\n当时的主要变化：${previous.changes || '未记录变化'}\n这只是你当时的推测和意图，可能误判或被骗；以当前可见证据重新判断，允许改变立场。发言和身份主张仍属于原说话人，不能因记入判断就升级为事实；计划也不代表已经执行。`
      : '',
    rendered.length > 0
      ? `你当前可见的材料（系统记录与玩家说法分列）：\n${rendered.join('\n\n')}`
      : '',
    renderExperiences(context.experiences ?? []),
    renderKnowledge(context.knowledge ?? []),
  ]);
}

/** 台账换天那几行自带括号，是分隔不是事实，不加项目符号。 */
function factLine(line: string): string {
  return line.startsWith('【') ? line : `- ${line}`;
}

/** 没有候选就是空串，模板里那一段跟着消失。 */
function optionsOf(context: TurnContext): string {
  if (context.options.length === 0) return '';
  return blocks(
    [
      '可以选的目标只有下面这些，选别的都不作数：',
      context.options.map((option) => `- ${option}`).join('\n'),
    ],
    '\n',
  );
}

/** 要求的形状写成文本。没有形状（发言）就是要一段话。 */
function shapeOf(shapeJson: Record<string, unknown> | null): string {
  return shapeJson === null ? '一段通顺的话' : JSON.stringify(shapeJson, null, 2);
}

/**
 * 输出格式。有形状的那几问走工具交，形状由工具定义约束；没形状的就是发言，写成一段话。
 *
 * 不再往提示词里贴一份 schema 让它照抄：贴过，模型有约三分之二的概率把 schema 本身抄回来交差，
 * 写多少句「它描述格式、不是答案」都拦不住。现在形状由 tool_choice 点名的那一个工具管。
 */
function outputOf(schemaJson: Record<string, unknown> | null): string {
  return schemaJson === null
    ? '结果直接写成一段话，不要 JSON，也不要前后缀说明。'
    : '这次的结果用规定好的那个工具交上来，不要写在正文里。';
}

function blocks(parts: readonly string[], separator = '\n\n'): string {
  return parts.filter((part) => part !== '').join(separator);
}
