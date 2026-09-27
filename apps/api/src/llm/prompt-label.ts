import type { LangfuseClient } from '@langfuse/client';
import { z } from 'zod';
import {
  LOCAL_TURN_PROMPTS,
  TURN_PROMPT_NAMES,
  renderGenerate,
  renderCritique,
  renderRevise,
  renderSummary,
} from '../turn/prompt';
import {
  EXPERIENCE_PROMPTS,
  LOCAL_EXPERIENCE_PROMPTS,
  experiencePrompts,
} from '../experience/prompt';
import { renderTemplate, type PromptSource, type PromptTemplate } from './prompt-template';

type PromptApi = Pick<LangfuseClient['api'], 'prompts' | 'promptVersion'>;
type PlatformPrompt = Awaited<ReturnType<PromptApi['prompts']['get']>>;
type TextVersion = PromptTemplate & { version: number; labels: string[] };
export interface PromptLabelPreview {
  name: string;
  label: string;
  current: TextVersion | null;
  target: TextVersion;
}

const SelectionSchema = z.object({
  name: z.string().trim().min(1),
  label: z
    .string()
    .trim()
    .min(1)
    .refine((value) => value !== 'latest', 'latest 由平台维护'),
  version: z.number().int().positive(),
});

function textVersion(prompt: PlatformPrompt): TextVersion {
  if (prompt.type !== 'text') throw new Error('该入口只支持文本模板');
  return {
    name: prompt.name,
    text: prompt.prompt,
    version: prompt.version,
    source: 'platform',
    labels: prompt.labels,
  };
}

async function readLabel(api: PromptApi, name: string, label: string): Promise<TextVersion | null> {
  try {
    return textVersion(await api.prompts.get(name, { label }, { maxRetries: 0 }));
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      error.statusCode === 404
    )
      return null;
    throw error;
  }
}

export async function previewPromptLabel(
  api: PromptApi,
  selection: { name: string; label: string; version: number },
): Promise<PromptLabelPreview> {
  const { name, label, version } = SelectionSchema.parse(selection);
  const [target, current] = await Promise.all([
    api.prompts.get(name, { version }, { maxRetries: 0 }).then(textVersion),
    readLabel(api, name, label),
  ]);
  if (target.name !== name || target.version !== version) throw new Error('平台未返回指定模板版本');
  return { name, label, current, target };
}

export async function applyPromptLabel(
  api: PromptApi,
  preview: PromptLabelPreview,
  expectedVersion: number | null,
): Promise<{ changed: boolean; beforeVersion: number | null; afterVersion: number }> {
  const fresh = await previewPromptLabel(api, {
    name: preview.name,
    label: preview.label,
    version: preview.target.version,
  });
  const beforeVersion = fresh.current?.version ?? null;
  if (beforeVersion !== expectedVersion)
    throw new Error(`标签当前版本为 ${beforeVersion ?? 'none'}，与 --expected 不一致，请重新预览`);
  if (fresh.target.text !== preview.target.text)
    throw new Error('目标模板正文在预览后发生变化，请重新预览');
  if (beforeVersion === fresh.target.version)
    return { changed: false, beforeVersion, afterVersion: beforeVersion };
  // 原生接口只移动指定标签，保留目标版本上的其他标签；不自动重试写请求。
  await api.promptVersion.update(
    fresh.name,
    fresh.target.version,
    { newLabels: [fresh.label] },
    { maxRetries: 0 },
  );
  const actual = await readLabel(api, fresh.name, fresh.label);
  if (actual?.version !== fresh.target.version || actual.text !== fresh.target.text)
    throw new Error('标签切换后读回不一致，请核查平台当前状态');
  return { changed: true, beforeVersion, afterVersion: actual.version };
}

/** 使用真实渲染器检查占位变量；不调用模型，也不判定策略内容。 */
export async function validateProjectPrompt(template: PromptTemplate): Promise<void> {
  const name = template.name;
  const isTurn = Object.values(TURN_PROMPT_NAMES).some((value) => value === name);
  const isExperience = Object.values(EXPERIENCE_PROMPTS).some((value) => value === name);
  if (!isTurn && !isExperience) throw new Error('仅支持当前对局与经验模板');
  const source: PromptSource = {
    strict: true,
    load: async (requested) =>
      requested === name
        ? template
        : (isTurn ? LOCAL_TURN_PROMPTS : LOCAL_EXPERIENCE_PROMPTS).load(requested),
  };
  if (isExperience) {
    for (const item of await experiencePrompts(source))
      renderTemplate(item, { identity: '', review: '', evidence: '' });
    return;
  }
  const context = {
    actor: { playerId: 'p1', seatNo: 1, role: '预言家' },
    day: 1,
    task: '',
    options: [],
    visible: [],
    skill: [],
  };
  if (name.startsWith('turn/generate-')) await renderGenerate(source, context, null);
  else if (name.startsWith('turn/critique-')) await renderCritique(source, context, '', null);
  else if (name.startsWith('turn/revise-')) await renderRevise(source, context, '', '', null);
  else await renderSummary(source, { day: 1, channel: '', speeches: [], count: 0, schemaJson: {} });
}
