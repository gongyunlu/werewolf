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
  load(name: string): Promise<PromptTemplate>;
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

/**
 * 冻结一局的提示词：先把要用的名字挨个从主源取一遍，全取到了就用这一份；有一条取不到，
 * 整局改用兜底源那份。
 *
 * 关键是整局一次、要么全平台要么全本地：平台的 production 版本随时会被人改，
 * 不冻结同一局就会前半段用一版、后半段用另一版；而半局平台半局兜底更是没法解释。
 */
export async function freezePrompts<N extends string>(
  primary: PromptSource,
  fallback: PromptSource,
  names: readonly N[],
  required: Readonly<Record<N, readonly string[]>>,
): Promise<Readonly<Record<N, PromptTemplate>>> {
  const templates = (await tryLoadAll(primary, names)) ?? (await loadAll(fallback, names));

  // 契约不满足就抛，不回退——平台上的模板被改坏了要当场知道，不能悄悄换成本地那份跑。
  for (const name of names) assertTemplateContract(templates[name], required[name]);
  return templates;
}

/** 全部取到才算数。有一条取不到就返回 null，交给调用方换源。 */
async function tryLoadAll<N extends string>(
  source: PromptSource,
  names: readonly N[],
): Promise<Readonly<Record<N, PromptTemplate>> | null> {
  try {
    return await loadAll(source, names);
  } catch {
    return null;
  }
}

async function loadAll<N extends string>(
  source: PromptSource,
  names: readonly N[],
): Promise<Readonly<Record<N, PromptTemplate>>> {
  const loaded = await Promise.all(names.map((name) => source.load(name)));
  return Object.fromEntries(
    names.map((name, index) => [name, loaded[index] as PromptTemplate]),
  ) as Readonly<Record<N, PromptTemplate>>;
}
