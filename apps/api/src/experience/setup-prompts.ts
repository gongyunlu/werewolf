import type { LangfuseClient } from '@langfuse/client';
import { snapshotPromptSource, type PromptTemplate } from '../llm/prompt-template';
import { experiencePrompts, LOCAL_EXPERIENCE_PROMPTS } from './prompt';

type PromptApi = LangfuseClient['api']['prompts'];

/** 只补齐缺失模板；已有 production 正文由平台维护，重复执行不新增版本。 */
export async function setupExperiencePrompts(api: PromptApi): Promise<PromptTemplate[]> {
  const templates = await experiencePrompts(LOCAL_EXPERIENCE_PROMPTS);
  const saved: PromptTemplate[] = [];
  const read = async (name: string, label: string) => {
    try {
      return await api.get(name, { label }, { maxRetries: 0 });
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
  };
  for (const template of templates) {
    let current = await read(template.name, 'production');
    if (!current) {
      if (await read(template.name, 'latest'))
        throw new Error(`模板 ${template.name} 已存在但未指定 production，请在平台选择版本`);
      await api.create(
        { name: template.name, type: 'text', prompt: template.text, labels: ['production'] },
        { maxRetries: 0 },
      );
      current = await read(template.name, 'production');
    }
    if (!current || current.type !== 'text')
      throw new Error(`模板 ${template.name} 不是可读取的文本模板`);
    saved.push({
      name: template.name,
      text: current.prompt,
      version: current.version,
      source: 'platform',
    });
  }
  return experiencePrompts(snapshotPromptSource(saved));
}
