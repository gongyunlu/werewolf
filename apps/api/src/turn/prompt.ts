import { z } from 'zod';
import {
  assertTemplateContract,
  localPromptSource,
  renderTemplate,
  type PromptSource,
  type PromptSourceKind,
  type PromptTemplate,
} from '../llm/prompt-template';
import type { TurnContext } from './request';

/** 质疑者的回答，形状固定，不跟着行动类型变。提示词与解析共用这一份。 */
export const CRITIQUE_SCHEMA = z.object({ accept: z.boolean(), issues: z.string() });

const CRITIQUE_SHAPE = z.toJSONSchema(CRITIQUE_SCHEMA) as Record<string, unknown>;

/** 行动图里的六条提示词。系统与用户分开，每条正文各自可调，互不牵连。 */
export const TURN_PROMPT_NAMES = {
  generateSystem: 'turn/generate-system',
  generateUser: 'turn/generate-user',
  critiqueSystem: 'turn/critique-system',
  critiqueUser: 'turn/critique-user',
  reviseSystem: 'turn/revise-system',
  reviseUser: 'turn/revise-user',
  /** 台账折摘要那两条。它不属于行动图，是持有这一局的人自己发的一问。 */
  summarySystem: 'turn/summary-system',
  summaryUser: 'turn/summary-user',
} as const;

export type TurnPromptName = (typeof TURN_PROMPT_NAMES)[keyof typeof TURN_PROMPT_NAMES];

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
}

/** 平台读不到时顶上来的兜底正文。它允许与平台不一致，平台改了不回填这里。 */
const TURN_PROMPT_TEXTS: Readonly<Record<TurnPromptName, string>> = {
  [TURN_PROMPT_NAMES.generateSystem]: `
    你在一局狼人杀里坐 {{seatNo}} 号，身份是{{role}}。
    只依据本次给出的信息判断，没写出来的就是你看不到的，别替规则补全。
  `,

  [TURN_PROMPT_NAMES.generateUser]: `
    第 {{day}} 天。
    {{facts}}
    这次要你做的事：{{task}}
    {{options}}
    {{output}}
  `,

  [TURN_PROMPT_NAMES.critiqueSystem]: `
    你在一局狼人杀里替对局把关。你只判断交上来的结果站不站得住，不替他改写，也不替他找理由。你看不到他的思考过程。
  `,

  [TURN_PROMPT_NAMES.critiqueUser]: `
    第 {{day}} 天，{{seatNo}} 号（{{role}}）被要求做的事：{{task}}
    {{facts}}
    {{options}}
    他交上来的结果：
    {{draft}}
    只判两件事：
    一、形式对不对。他这次该交出来的形状是：
    {{shape}}
    二、和上面的已知信息有没有对不上的地方。
    站得住就 accept 写 true；站不住写 false，把问题一条一条写进 issues。
    {{output}}
  `,

  [TURN_PROMPT_NAMES.reviseSystem]: `
    你在一局狼人杀里坐 {{seatNo}} 号，身份是{{role}}。
    只依据本次给出的信息判断，没写出来的就是你看不到的，别替规则补全。
    把交上去的结果按审核意见改一遍，只改该改的地方。
  `,

  [TURN_PROMPT_NAMES.reviseUser]: `
    第 {{day}} 天。
    {{facts}}
    这次要你做的事：{{task}}
    {{options}}
    上一版交的是：
    {{draft}}
    审核意见：
    {{issues}}
    {{output}}
  `,

  [TURN_PROMPT_NAMES.summarySystem]: `
    你在替一局狼人杀整理当天的发言纪要。整理好之后原先的发言就不再逐字留着了，你写下的就是后面的人能看到的全部。
    只留对往后的判断有用的东西：谁跳了什么身份、谁验了谁、谁把矛头指向谁、谁改过立场、谁在哪件事上表了态。
    不复述原话，不补发言里没有的东西，也不替任何人下结论。
  `,

  [TURN_PROMPT_NAMES.summaryUser]: `
    第 {{day}} 天，这一份是{{channel}}。
    {{speeches}}
    上面每个人的发言各压成一条，一共要 {{count}} 条，一个人都不能落下。
    {{output}}
  `,
};

/** 每条模板必须出现的变量。渲染只查得出「模板要的代码没给」，反向那条靠这张表。 */
export const REQUIRED_PROMPT_VARIABLES: Readonly<Record<TurnPromptName, readonly string[]>> = {
  [TURN_PROMPT_NAMES.generateSystem]: ['seatNo', 'role'],
  [TURN_PROMPT_NAMES.generateUser]: ['day', 'facts', 'task', 'options', 'output'],
  [TURN_PROMPT_NAMES.critiqueSystem]: [],
  [TURN_PROMPT_NAMES.critiqueUser]: [
    'day',
    'seatNo',
    'role',
    'task',
    'facts',
    'options',
    'draft',
    'shape',
    'output',
  ],
  [TURN_PROMPT_NAMES.reviseSystem]: ['seatNo', 'role'],
  [TURN_PROMPT_NAMES.reviseUser]: ['day', 'facts', 'task', 'options', 'draft', 'issues', 'output'],
  [TURN_PROMPT_NAMES.summarySystem]: [],
  [TURN_PROMPT_NAMES.summaryUser]: ['day', 'channel', 'speeches', 'count', 'output'],
};

/** 本地兜底源。平台那条读不到时顶上。 */
export const LOCAL_TURN_PROMPTS: PromptSource = localPromptSource(TURN_PROMPT_TEXTS);

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

  return { system, user };
}

/**
 * 独立质疑。
 * 只给「被要求做什么」和「交上来的东西」，不给生成时那套系统提示词与思考过程——
 * 看不到过程才不会顺着过程替它找理由。
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
    renderPart(source, TURN_PROMPT_NAMES.critiqueSystem, {}),
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

  return { system, user };
}

/** 带着质疑意见重做一版。 */
export async function renderRevise(
  source: PromptSource,
  context: TurnContext,
  draft: string,
  issues: string,
  schemaJson: Record<string, unknown> | null,
): Promise<RenderedTurn> {
  const [system, user] = await Promise.all([
    renderPart(source, TURN_PROMPT_NAMES.reviseSystem, identityOf(context), context.skill),
    renderPart(source, TURN_PROMPT_NAMES.reviseUser, {
      ...briefOf(context, schemaJson),
      draft,
      issues,
    }),
  ]);

  return { system, user };
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
  const template = await loadTurnPrompt(source, name);
  const text = renderTemplate(template, variables);

  return {
    template: name,
    version: template.version,
    source: template.source,
    text: skill.length === 0 ? text : `${text}\n\n${skill.join('\n\n')}`,
  };
}

/** 取一条模板，平台读不到就退到本地那份。契约不满足一律抛，不回退——模板被改坏了要当场知道。 */
async function loadTurnPrompt(source: PromptSource, name: TurnPromptName): Promise<PromptTemplate> {
  const template = await source.load(name).catch(() => LOCAL_TURN_PROMPTS.load(name));
  assertTemplateContract(template, REQUIRED_PROMPT_VARIABLES[name]);
  return template;
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
  if (context.visible.length === 0) return '';

  // 块之间空一行，免得上一块的最后一条跟下一块的标题连成一串。
  const rendered = context.visible.map(
    (block) => `【${block.title}】\n${block.lines.map(factLine).join('\n')}`,
  );

  return `你已知的事实：\n${rendered.join('\n\n')}`;
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
