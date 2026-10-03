import type { KnowledgeContent } from '@werewolf/shared';
import { embeddingKey, type EmbeddingRuntime } from '../llm/embedding';

export const KNOWLEDGE_TEXT_VERSION = 'knowledge-search-v1';

export function knowledgeEmbeddingKey(
  runtime: Pick<EmbeddingRuntime, 'access' | 'dimensions'>,
): string {
  return embeddingKey(runtime, KNOWLEDGE_TEXT_VERSION);
}

/** 检索正文只包含策略语义；网页地址、采集日期和来源编号保留在快照。 */
export function knowledgeText(content: KnowledgeContent): string {
  return [
    content.title,
    `适用条件：${content.conditions}`,
    content.body,
    `规则依据：${content.rulesBasis}`,
    `本地适配：${content.adaptation}`,
  ].join('\n');
}
