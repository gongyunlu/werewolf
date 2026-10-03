import {
  KNOWLEDGE_CHARACTERS,
  KNOWLEDGE_LIMIT,
  type ExperienceSnapshot,
  type KnowledgeSnapshot,
} from '@werewolf/shared';
import { EXPERIENCE_CHARACTERS, EXPERIENCE_LIMIT } from './selection';

export const RETRIEVAL_POLICY = { version: 'hybrid-v3', minRelevance: 2, recallLimit: 20 };

export type RetrievalDocument =
  | { key: string; kind: 'experience'; text: string; snapshot: ExperienceSnapshot }
  | { key: string; kind: 'knowledge'; text: string; snapshot: KnowledgeSnapshot };

export type RetrievalCandidate = RetrievalDocument & {
  similarity?: number;
  keywordScore?: number;
  vectorRank?: number;
  keywordRank?: number;
  fusionScore: number;
};

export interface ReferenceJudgment {
  key: string;
  relevance: number;
  applicable: boolean;
  reason: string;
  duplicateOf: string | null;
}

export interface ReferenceDecision extends ReferenceJudgment {
  selected: boolean;
  rejection: 'inapplicable' | 'irrelevant' | 'duplicate' | 'budget' | null;
}

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const domainWords = [
  '禁连守',
  '连守',
  '退水',
  '屠边',
  '白狼王',
  '狼王',
  '警徽流',
  '金水',
  '银水',
  '查杀',
  '悍跳',
  '对跳',
  '空守',
];
const stopWords = new Set([
  '的',
  '了',
  '是',
  '在',
  '和',
  '与',
  '或',
  '有',
  '没有',
  '一个',
  '这',
  '那',
  '你',
  '我',
  '他',
  '她',
  '号',
]);

/** 中文词边界由 ICU 处理，补充容易被拆开的狼人杀术语。 */
export function tokenizeChinese(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const words = [...segmenter.segment(normalized)]
    .filter((part) => part.isWordLike && !stopWords.has(part.segment))
    .map((part) => part.segment);
  for (const word of domainWords) {
    if (words.includes(word)) continue;
    words.push(...Array.from(normalized.matchAll(new RegExp(word, 'g')), () => word));
  }
  return words;
}

export function rankKeywords<T extends { key: string; text: string }>(
  query: string,
  documents: readonly T[],
  limit = RETRIEVAL_POLICY.recallLimit,
): Array<{ document: T; score: number }> {
  const queryTerms = [...new Set(tokenizeChinese(query))];
  const indexed = documents.map((document) => {
    const terms = tokenizeChinese(document.text);
    const frequencies = new Map<string, number>();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    return { document, length: terms.length, frequencies };
  });
  const averageLength = indexed.reduce((sum, row) => sum + row.length, 0) / indexed.length;
  const documentFrequency = new Map(
    queryTerms.map((term) => [term, indexed.filter((row) => row.frequencies.has(term)).length]),
  );
  return indexed
    .map(({ document, length, frequencies }) => ({
      document,
      score: queryTerms.reduce((score, term) => {
        const frequency = frequencies.get(term) ?? 0;
        if (!frequency) return score;
        const df = documentFrequency.get(term)!;
        const idf = Math.log(1 + (indexed.length - df + 0.5) / (df + 0.5));
        return (
          score +
          (idf * frequency * 2.2) / (frequency + 1.2 * (0.25 + (0.75 * length) / averageLength))
        );
      }, 0),
    }))
    .filter((row) => row.score > 0)
    .toSorted((a, b) => b.score - a.score || a.document.key.localeCompare(b.document.key))
    .slice(0, limit);
}

/** 两路分数不直接相加；RRF 按名次融合，保留各路证据。 */
export function fuseCandidates(
  vector: readonly { document: RetrievalDocument; score: number }[],
  lexical: readonly { document: RetrievalDocument; score: number }[],
  limit = RETRIEVAL_POLICY.recallLimit,
): RetrievalCandidate[] {
  const candidates = new Map<string, RetrievalCandidate>();
  for (const [route, hits] of [
    ['vector', vector],
    ['keyword', lexical],
  ] as const) {
    hits.forEach(({ document, score }, index) => {
      const row = candidates.get(document.key) ?? { ...document, fusionScore: 0 };
      row.fusionScore += 1 / (60 + index + 1);
      if (route === 'vector') {
        row.similarity = score;
        row.vectorRank = index + 1;
      } else {
        row.keywordScore = score;
        row.keywordRank = index + 1;
      }
      candidates.set(document.key, row);
    });
  }
  return [...candidates.values()]
    .toSorted((a, b) => b.fusionScore - a.fusionScore || a.key.localeCompare(b.key))
    .slice(0, limit);
}

export function selectReferences(
  candidates: readonly RetrievalCandidate[],
  judgments: readonly ReferenceJudgment[],
  minRelevance = RETRIEVAL_POLICY.minRelevance,
): {
  experiences: ExperienceSnapshot[];
  knowledge: KnowledgeSnapshot[];
  decisions: ReferenceDecision[];
} {
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  if (
    judgments.length !== candidates.length ||
    new Set(judgments.map((row) => row.key)).size !== candidates.length ||
    judgments.some((row) => !byKey.has(row.key))
  )
    throw new Error('重排结果必须完整且不重复地覆盖冻结候选');
  const sorted = [...judgments].toSorted(
    (a, b) =>
      b.relevance - a.relevance ||
      byKey.get(b.key)!.fusionScore - byKey.get(a.key)!.fusionScore ||
      a.key.localeCompare(b.key),
  );
  const experiences: ExperienceSnapshot[] = [];
  const knowledge: KnowledgeSnapshot[] = [];
  const selectedKeys = new Set<string>();
  const groups = new Map(candidates.map((candidate) => [candidate.key, candidate.key]));
  const groupOf = (key: string): string => {
    let group = key;
    while (groups.get(group)! !== group) group = groups.get(group)!;
    return group;
  };
  for (const judgment of judgments) {
    if (judgment.duplicateOf === null) continue;
    if (!byKey.has(judgment.duplicateOf)) throw new Error('重复候选编号不存在');
    groups.set(groupOf(judgment.key), groupOf(judgment.duplicateOf));
  }
  const texts = new Set<string>();
  const decisions: ReferenceDecision[] = [];
  for (const judgment of sorted) {
    const candidate = byKey.get(judgment.key)!;
    const content =
      candidate.kind === 'experience' ? candidate.snapshot : candidate.snapshot.content;
    const normalized = `${content.conditions}\n${content.body}`
      .normalize('NFKC')
      .replace(/\s|[，。；：、！？,.!?;:]/gu, '');
    let rejection: ReferenceDecision['rejection'] = !judgment.applicable
      ? 'inapplicable'
      : judgment.relevance < minRelevance
        ? 'irrelevant'
        : texts.has(normalized) || selectedKeys.has(groupOf(judgment.key))
          ? 'duplicate'
          : null;
    if (!rejection) {
      if (candidate.kind === 'experience') {
        if (
          experiences.length >= EXPERIENCE_LIMIT ||
          JSON.stringify([...experiences, candidate.snapshot]).length > EXPERIENCE_CHARACTERS
        )
          rejection = 'budget';
        else experiences.push(candidate.snapshot);
      } else if (
        knowledge.length >= KNOWLEDGE_LIMIT ||
        JSON.stringify([...knowledge, candidate.snapshot]).length > KNOWLEDGE_CHARACTERS
      )
        rejection = 'budget';
      else knowledge.push(candidate.snapshot);
    }
    if (!rejection) {
      selectedKeys.add(groupOf(judgment.key));
      texts.add(normalized);
    }
    decisions.push({ ...judgment, selected: rejection === null, rejection });
  }
  return { experiences, knowledge, decisions };
}
