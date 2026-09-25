import { createHash } from 'node:crypto';
import type { ModelRequest, ModelTool } from '../llm/model-port';
import {
  snapshotPromptSource,
  type PromptSource,
  type PromptTemplate,
} from '../llm/prompt-template';
import { renderGenerate, TURN_PROMPT_NAMES } from './prompt';
import type { DecisionSnapshot } from './snapshot';

export interface PromptComparison {
  input: Pick<DecisionSnapshot, 'context' | 'schema' | 'model' | 'capability'> & {
    tool?: ModelTool;
  };
  inputHash: string;
  promptName: string;
  variants: {
    label: 'baseline' | 'candidate';
    templates: PromptTemplate[];
    request: ModelRequest;
  }[];
}

/** 对象字段顺序不影响同一输入的指纹。 */
export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function canonical(item: unknown): unknown {
  if (Array.isArray(item)) return item.map(canonical);
  if (item !== null && typeof item === 'object') {
    return Object.fromEntries(
      Object.entries(item)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => [key, canonical(val)]),
    );
  }
  return item;
}

/** 只读取原行动快照中的玩家输入，不读取终局、后续台账或复盘结果。 */
export async function preparePromptComparison(
  snapshot: DecisionSnapshot,
  source: PromptSource,
  selection: { name: string; baseline: number; candidate: number },
  tool?: ModelTool,
): Promise<PromptComparison> {
  const names = [TURN_PROMPT_NAMES.generateSystem, TURN_PROMPT_NAMES.generateUser];
  if (!names.some((name) => name === selection.name))
    throw new Error('只支持生成环节的 system 或 user 模板');
  if (
    ![selection.baseline, selection.candidate].every((v) => Number.isSafeInteger(v) && v > 0) ||
    selection.baseline === selection.candidate
  )
    throw new Error('必须选择两个不同的正整数版本');
  if ((snapshot.schema !== null) !== (tool !== undefined))
    throw new Error('原行动的工具定义与结构约束不一致');

  const companionName = names.find((name) => name !== selection.name)!;
  const recorded = snapshot.prompts.find((prompt) => prompt.template === companionName);
  if (!recorded || recorded.source !== 'platform' || recorded.version === null) {
    throw new Error('原行动未记录另一段模板的平台版本，无法固定对照条件');
  }
  const load = async (name: string, version: number) => {
    const template = await source.load(name, version);
    if (template.name !== name || template.version !== version || template.source !== 'platform') {
      throw new Error(`未取得提示词 ${name} 的指定版本 ${version}`);
    }
    return template;
  };
  const [companion, baseline, candidate] = await Promise.all([
    load(companionName, recorded.version),
    load(selection.name, selection.baseline),
    load(selection.name, selection.candidate),
  ]);
  const input = structuredClone({
    context: snapshot.context,
    schema: snapshot.schema,
    model: snapshot.model,
    capability: snapshot.capability,
    ...(tool ? { tool } : {}),
  });
  const variants: PromptComparison['variants'] = [];
  for (const [index, selected] of [baseline, candidate].entries()) {
    const templates = names.map((name) => (name === selection.name ? selected : companion));
    const turn = await renderGenerate(snapshotPromptSource(templates), input.context, input.schema);
    variants.push({
      label: index === 0 ? 'baseline' : 'candidate',
      templates,
      request: {
        system: turn.system.text,
        prompt: turn.user.text,
        ...(tool ? { tool: input.tool } : {}),
        prompts: templates.map(({ name, version, source: kind }) => ({
          name,
          version,
          source: kind,
        })),
        primaryPrompt: selection.name,
      },
    });
  }
  return { input, inputHash: fingerprint(input), promptName: selection.name, variants };
}
