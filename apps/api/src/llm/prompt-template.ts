/** 模板从哪来。平台是源，本地那份只是平台读不到时顶上的兜底。 */
export type PromptSourceKind = 'platform' | 'local';

/**
 * 一条提示词模板。正文占位写成 {{变量名}}。
 * 正文里不允许有逻辑：平台上的模板改不动代码，所以「这一段要不要出现」得由调用方
 * 往变量里塞空串来定，模板只管摆位置。
 */
export interface PromptTemplate {
  name: string;
  text: string;
  /** 平台版本号；本地兜底没有版本号，所以是 null。 */
  version: number | null;
  source: PromptSourceKind;
}

/** 模板契约不满足：调用方少给了变量，或者模板被改得缺了必需的变量。 */
export class PromptContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptContractError';
  }
}

/** 提示词源：按名字取一条模板，取不到就抛。 */
export interface PromptSource {
  /** 已固定的源不允许在缺失时换成本地正文。 */
  strict?: boolean;
  load(name: string, version?: number): Promise<PromptTemplate>;
}

/** 保存正文后恢复不再依赖平台在线，也不受标签移动影响。 */
export function snapshotPromptSource(templates: readonly PromptTemplate[]): PromptSource {
  const saved = new Map(templates.map((template) => [template.name, structuredClone(template)]));
  return {
    strict: true,
    async load(name, version) {
      const template = saved.get(name);
      if (!template || (version !== undefined && template.version !== version)) {
        throw new PromptContractError(`固定快照没有提示词 "${name}" 的所需版本`);
      }
      return structuredClone(template);
    },
  };
}

/** 正文里出现的变量名。 */
export function extractPromptVariables(text: string): string[] {
  return [
    ...new Set(Array.from(text.matchAll(/\{\{\s*(\w+)\s*\}\}/g), (match) => match[1] as string)),
  ];
}

/**
 * 渲染模板。
 * 少给变量就抛：模板（尤其平台上那份）加了个新变量而代码没跟上，必须当场炸。
 */
export function renderTemplate(
  template: PromptTemplate,
  variables: Record<string, string>,
): string {
  const missing = extractPromptVariables(template.text).filter((name) => !(name in variables));
  if (missing.length > 0)
    throw new PromptContractError(`提示词 "${template.name}" 缺少变量: ${missing.join(', ')}`);

  // 独占一行且取值为空的变量，连它占的那一整行一起去掉，正文里不留空行。
  // 不做全局空行折叠：变量值里的空行是调用方（乃至模型）的原文，渲染不该动它。
  const blanked = template.text.replace(
    /\n[ \t]*\{\{\s*(\w+)\s*\}\}[ \t]*\n/g,
    (match, name: string) => (variables[name] === '' ? '' : match),
  );

  return blanked
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => variables[name] as string)
    .trim();
}

/**
 * 模板里必须出现这些变量。
 * 渲染只能查出「模板要的代码没给」，查不出「模板被人删掉了一段」——反向那条靠这张表兜。
 */
export function assertTemplateContract(
  template: PromptTemplate,
  required: readonly string[],
): void {
  const present = new Set(extractPromptVariables(template.text));
  const missing = required.filter((name) => !present.has(name));
  if (missing.length > 0)
    throw new PromptContractError(`提示词 "${template.name}" 缺少必需变量: ${missing.join(', ')}`);
}

/** 用一张写死在代码里的正文表做提示词源。本地兜底没有版本号。 */
export function localPromptSource(texts: Readonly<Record<string, string>>): PromptSource {
  return {
    async load(name: string): Promise<PromptTemplate> {
      const text = texts[name];
      if (text === undefined) throw new PromptContractError(`本地没有提示词 "${name}"`);
      return { name, text, version: null, source: 'local' };
    },
  };
}
