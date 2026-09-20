import { z } from 'zod';
import {
  freezePrompts,
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
} as const;

export type TurnPromptName = (typeof TURN_PROMPT_NAMES)[keyof typeof TURN_PROMPT_NAMES];

/** 一局开跑前冻住的提示词。整局只用这一份。 */
export type FrozenPrompts = Readonly<Record<TurnPromptName, PromptTemplate>>;

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
};

/** 一局要冻的提示词名字。 */
export const TURN_PROMPT_NAMES_ALL: readonly TurnPromptName[] = Object.values(TURN_PROMPT_NAMES);

/** 本地兜底源。平台连不上时整局走它。 */
export const LOCAL_TURN_PROMPTS: PromptSource = localPromptSource(TURN_PROMPT_TEXTS);

/**
 * 冻一局的提示词。
 * 平台是源，本地那份只在平台整份取不到时顶上；取到一半不算数，整局换兜底。
 */
export function freezeTurnPrompts(platform: PromptSource): Promise<FrozenPrompts> {
  return freezePrompts(
    platform,
    LOCAL_TURN_PROMPTS,
    TURN_PROMPT_NAMES_ALL,
    REQUIRED_PROMPT_VARIABLES,
  );
}

/** 生成这一次行动的结果。 */
export function renderGenerate(
  prompts: FrozenPrompts,
  context: TurnContext,
  schemaJson: Record<string, unknown> | null,
): RenderedTurn {
  return {
    system: renderPart(prompts[TURN_PROMPT_NAMES.generateSystem], identityOf(context)),
    user: renderPart(prompts[TURN_PROMPT_NAMES.generateUser], briefOf(context, schemaJson)),
  };
}

/**
 * 独立质疑。
 * 只给「被要求做什么」和「交上来的东西」，不给生成时那套系统提示词与思考过程——
 * 看不到过程才不会顺着过程替它找理由。
 * 可选项得给：「目标必须在候选里」正是它要判的形式之一，不给就没法判。
 */
export function renderCritique(
  prompts: FrozenPrompts,
  context: TurnContext,
  draft: string,
  schemaJson: Record<string, unknown> | null,
): RenderedTurn {
  return {
    system: renderPart(prompts[TURN_PROMPT_NAMES.critiqueSystem], {}),
    user: renderPart(prompts[TURN_PROMPT_NAMES.critiqueUser], {
      day: String(context.day),
      seatNo: String(context.actor.seatNo),
      role: context.actor.role,
      task: context.task,
      facts: factsOf(context),
      options: optionsOf(context),
      draft,
      shape: shapeOf(schemaJson),
      output: outputOf(CRITIQUE_SHAPE),
    }),
  };
}

/** 带着质疑意见重做一版。 */
export function renderRevise(
  prompts: FrozenPrompts,
  context: TurnContext,
  draft: string,
  issues: string,
  schemaJson: Record<string, unknown> | null,
): RenderedTurn {
  return {
    system: renderPart(prompts[TURN_PROMPT_NAMES.reviseSystem], identityOf(context)),
    user: renderPart(prompts[TURN_PROMPT_NAMES.reviseUser], {
      ...briefOf(context, schemaJson),
      draft,
      issues,
    }),
  };
}

function renderPart(template: PromptTemplate, variables: Record<string, string>): RenderedPrompt {
  return {
    template: template.name as TurnPromptName,
    version: template.version,
    source: template.source,
    text: renderTemplate(template, variables),
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
  if (context.visible.length === 0) return '';
  return blocks(['你已知的事实：', context.visible.map((fact) => `- ${fact}`).join('\n')], '\n');
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

/** 要求的形状写成文本。没有 schema 就是要一段话。 */
function shapeOf(schemaJson: Record<string, unknown> | null): string {
  return schemaJson === null ? '一段通顺的话' : JSON.stringify(schemaJson, null, 2);
}

/** 输出格式。没有 schema 就是发言，结果是一段话。 */
function outputOf(schemaJson: Record<string, unknown> | null): string {
  if (schemaJson === null) return '结果直接写成一段话，不要 JSON，也不要前后缀说明。';
  return blocks(
    [
      '结果按下面这个 JSON Schema 输出，只输出这一个 JSON 对象，不要代码围栏、不要额外说明：',
      shapeOf(schemaJson),
    ],
    '\n',
  );
}

function blocks(parts: readonly string[], separator = '\n\n'): string {
  return parts.filter((part) => part !== '').join(separator);
}
