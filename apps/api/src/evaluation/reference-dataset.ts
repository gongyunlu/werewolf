import { ACTION_TYPES } from '@werewolf/shared';
import type { PrismaClient } from '../generated/prisma/client';
import type { ModelTool } from '../llm/model-port';
import { TURN_PROMPT_NAMES } from '../prompts/catalog';
import type { PromptSource, PromptTemplate } from '../prompts/template';
import type { TurnContext } from '../turn/request';
import type { TurnOutcome } from '../turn/graph';
import type { DecisionSnapshot } from '../turn/snapshot';
import { fingerprint } from '../turn/prompt-comparison';
import { assertCorpus, corpusBefore, type FrozenReferenceCorpus } from './reference-corpus';

export interface ReferenceLabel {
  relevance: 0 | 1 | 2 | 3;
  applicable: boolean;
  note: string;
}
export interface ReferenceSample {
  id: string;
  source: {
    gameId: string;
    actionKey: string;
    createdAt: string;
    traceId?: string;
    observationId?: string;
  };
  boardId: string;
  role: string;
  split: 'development' | 'test';
  context: TurnContext;
  actionType: DecisionSnapshot['actionType'];
  preset: DecisionSnapshot['preset'];
  schema: DecisionSnapshot['schema'];
  tool?: ModelTool;
  model: string;
  capability: DecisionSnapshot['capability'];
  labels: Record<string, ReferenceLabel> | null;
  annotation: { author: string; basis: 'human' | 'agent-reviewed'; note: string } | null;
}
export interface ReferenceDataset {
  version: 1;
  temporalPolicy: 'at-action' | 'frozen-retrospective';
  hash: string;
  corpus: FrozenReferenceCorpus;
  templates: PromptTemplate[];
  samples: ReferenceSample[];
}

export function sealDataset(input: Omit<ReferenceDataset, 'hash'>): ReferenceDataset {
  return { ...input, hash: fingerprint(input) };
}

export function sampleCorpus(dataset: ReferenceDataset, sample: ReferenceSample) {
  return corpusBefore(
    dataset.corpus,
    dataset.temporalPolicy === 'at-action' ? sample.source.createdAt : dataset.corpus.createdAt,
    dataset.samples.map((item) => item.source.gameId),
  );
}

/** 标签必须覆盖这份冻结语料；未标注不是“不相关”。 */
export function assertDataset(dataset: ReferenceDataset, requireLabels = false) {
  const { hash, ...body } = dataset;
  if (dataset.version !== 1 || hash !== fingerprint(body))
    throw new Error('评测数据与冻结指纹不一致');
  assertCorpus(dataset.corpus);
  if (!['at-action', 'frozen-retrospective'].includes(dataset.temporalPolicy))
    throw new Error('必须明确语料时间策略');
  if (!dataset.samples.length) throw new Error('评测集没有行动样本');
  const games = new Map<string, string>();
  const ids = new Set<string>();
  for (const sample of dataset.samples) {
    if (ids.has(sample.id)) throw new Error('评测样本ID重复');
    ids.add(sample.id);
    const previous = games.get(sample.source.gameId);
    if (previous && previous !== sample.split) throw new Error('同一来源对局不能跨开发集和测试集');
    games.set(sample.source.gameId, sample.split);
    if (sample.context.experiences?.length || sample.context.knowledge?.length)
      throw new Error('评测输入不能预装历史检索结果');
    if (requireLabels && (!sample.labels || !sample.annotation))
      throw new Error(`样本 ${sample.id} 尚未完成独立标注`);
    if (!sample.labels) continue;
    const corpus = sampleCorpus(dataset, sample);
    const keys = [
      ...corpus.experiences.map((row) => `experience/${row.snapshot.id}/${row.snapshot.version}`),
      ...corpus.knowledge.map((row) => `knowledge/${row.snapshot.versionId}`),
    ];
    if (
      keys.length !== Object.keys(sample.labels).length ||
      keys.some((key) => !sample.labels?.[key])
    )
      throw new Error(`样本 ${sample.id} 的标签没有完整覆盖可用语料`);
    for (const label of Object.values(sample.labels)) {
      if (
        ![0, 1, 2, 3].includes(label.relevance) ||
        typeof label.applicable !== 'boolean' ||
        !label.note.trim()
      )
        throw new Error(`样本 ${sample.id} 的相关性标签无效`);
    }
  }
}

function groupSamples(
  samples: ReferenceSample[],
  keyOf: (sample: ReferenceSample) => string | number,
) {
  const groups = new Map<string | number, ReferenceSample[]>();
  for (const sample of samples) {
    const key = keyOf(sample);
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function roundRobin(groups: ReferenceSample[][], limit: number) {
  const selected: ReferenceSample[] = [];
  for (let offset = 0; selected.length < limit; offset++) {
    let added = false;
    for (const group of groups) {
      if (group[offset] && selected.length < limit) {
        selected.push(group[offset]!);
        added = true;
      }
    }
    if (!added) break;
  }
  return selected;
}

/** 先均衡开发集与测试集，再轮取各天及其板型、角色、行动，余量由其他组补齐。 */
export function stratifiedSamples(samples: ReferenceSample[], limit: number) {
  const splits = ['development', 'test'].map((split) => {
    const days = groupSamples(
      samples.filter((sample) => sample.split === split),
      (sample) => sample.context.day,
    );
    return roundRobin(
      days.map((day) =>
        roundRobin(
          groupSamples(day, (sample) => `${sample.boardId}/${sample.role}/${sample.actionType}`),
          limit,
        ),
      ),
      limit,
    );
  });
  return roundRobin(splits, limit);
}

export async function exportReferenceDataset(input: {
  db: PrismaClient;
  corpus: FrozenReferenceCorpus;
  gameIds: string[];
  testGameIds: string[];
  limit: number;
  promptSource: PromptSource;
  temporalPolicy: ReferenceDataset['temporalPolicy'];
}): Promise<ReferenceDataset> {
  if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error('样本数量必须是正整数');
  if (input.testGameIds.some((id) => !input.gameIds.includes(id)))
    throw new Error('测试局必须属于本次导出的对局');
  const [actions, templates] = await Promise.all([
    input.db.actionRecord.findMany({
      where: { gameId: { in: input.gameIds }, status: 'done' },
      include: { game: true },
      orderBy: { createdAt: 'asc' },
    }),
    Promise.all(Object.values(TURN_PROMPT_NAMES).map((name) => input.promptSource.load(name))),
  ]);
  const asked = await input.db.askedPrompt.findMany({
    where: { gameId: { in: input.gameIds }, step: 'generate', formatAttempt: 1 },
    select: { actionKey: true, tool: true, traceId: true, spanId: true },
    orderBy: { id: 'asc' },
  });
  const calls = new Map(asked.map((row) => [row.actionKey, row]));
  const samples = actions.flatMap((row): ReferenceSample[] => {
    const snapshot = (row.outcome as unknown as TurnOutcome).snapshot;
    const call = calls.get(row.actionKey);
    const role = (row.experienceRetrieval as { scope?: { role?: string } } | null)?.scope?.role;
    // 早期档案没有检索范围或生成原始记录，不凭角色显示名补写历史。
    if (!snapshot || !call || !role || !Object.values(ACTION_TYPES).includes(snapshot.actionType))
      return [];
    const { experiences: _experiences, knowledge: _knowledge, ...context } = snapshot.context;
    return [
      {
        id: row.actionKey,
        source: {
          gameId: row.gameId,
          actionKey: row.actionKey,
          createdAt: row.createdAt.toISOString(),
          ...(call.traceId ? { traceId: call.traceId } : {}),
          ...(call.spanId ? { observationId: call.spanId } : {}),
        },
        boardId: row.game.boardId,
        role,
        split: input.testGameIds.includes(row.gameId) ? 'test' : 'development',
        context,
        actionType: snapshot.actionType,
        preset: snapshot.preset,
        schema: snapshot.schema,
        ...(call.tool ? { tool: call.tool as unknown as ModelTool } : {}),
        model: snapshot.model,
        capability: snapshot.capability,
        labels: null,
        annotation: null,
      },
    ];
  });
  const dataset = sealDataset({
    version: 1,
    temporalPolicy: input.temporalPolicy,
    corpus: input.corpus,
    templates,
    samples: stratifiedSamples(samples, input.limit),
  });
  if (input.testGameIds.length && !dataset.samples.some((sample) => sample.split === 'test'))
    throw new Error('指定测试局未导出有效行动样本，请检查行动档案和样本数量');
  assertDataset(dataset);
  return dataset;
}
