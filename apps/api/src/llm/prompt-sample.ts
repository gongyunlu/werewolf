import type { LangfuseClient } from '@langfuse/client';
import { z } from 'zod';
import { comparisonInput, fingerprint, type PromptComparison } from '../turn/prompt-comparison';
import type { DecisionSnapshot } from '../turn/snapshot';
import type { ModelTool } from './model-port';

export type PromptDatasetItem = Awaited<ReturnType<LangfuseClient['api']['datasetItems']['get']>>;
export interface PromptSampleSource {
  gameId: string;
  actionKey: string;
  callId?: string;
  traceId?: string;
  observationId?: string;
}

export const SampleFeedbackSchema = z.object({
  category: z.enum(['rule', 'perspective', 'fact', 'display', 'strategy', 'reference']),
  note: z.string().trim().min(1).max(4000),
});
const SampleMetadataSchema = z.object({
  schema: z.literal('werewolf-action-sample-v1'),
  inputHash: z.string(),
  source: z.object({
    gameId: z.string().min(1),
    actionKey: z.string().min(1),
    callId: z.string().optional(),
    traceId: z.string().optional(),
    observationId: z.string().optional(),
  }),
  feedback: SampleFeedbackSchema,
});

export function sampleMetadata(item: PromptDatasetItem) {
  if (item.status !== 'ACTIVE') throw new Error('样本已归档，不能用于对照');
  const metadata = SampleMetadataSchema.parse(item.metadata);
  if (fingerprint(item.input) !== metadata.inputHash)
    throw new Error('样本输入已被修改，请从原行动重新保存');
  return metadata;
}

/** 样本仍需与本地原行动对应；人工意见和平台编辑不能替换玩家当时的输入。 */
export function assertPromptSample(
  item: PromptDatasetItem,
  input: PromptComparison['input'],
  source: PromptSampleSource,
) {
  const metadata = sampleMetadata(item);
  if (
    metadata.inputHash !== fingerprint(input) ||
    fingerprint(metadata.source) !== fingerprint(source) ||
    (item.sourceTraceId ?? undefined) !== source.traceId ||
    (item.sourceObservationId ?? undefined) !== source.observationId
  ) {
    throw new Error('样本与原行动输入或来源不一致');
  }
}

export async function savePromptSample(input: {
  client: LangfuseClient;
  datasetName: string;
  snapshot: DecisionSnapshot;
  tool?: ModelTool;
  source: PromptSampleSource;
  feedback: z.input<typeof SampleFeedbackSchema>;
}): Promise<PromptDatasetItem> {
  const feedback = SampleFeedbackSchema.parse(input.feedback);
  const datasetName = z.string().trim().min(1).parse(input.datasetName);
  const original = comparisonInput(input.snapshot, input.tool);
  const inputHash = fingerprint(original);
  // 同一集合内重复保存同一行动只更新人工说明，不产生重复样本。
  const id = fingerprint({ datasetName, source: input.source, inputHash });
  await input.client.api.datasets.create({ name: datasetName });
  const item = await input.client.dataset.createItem({
    datasetName,
    id,
    input: original,
    metadata: {
      schema: 'werewolf-action-sample-v1',
      inputHash,
      source: input.source,
      feedback,
      prompts: input.snapshot.prompts.map(({ template, version, source }) => ({
        name: template,
        version,
        source,
      })),
    },
    sourceTraceId: input.source.traceId,
    sourceObservationId: input.source.observationId,
  });
  assertPromptSample(item, original, input.source);
  return item;
}
