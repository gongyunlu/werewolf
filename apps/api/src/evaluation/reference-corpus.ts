import {
  ExperienceSnapshotSchema,
  KnowledgeSnapshotSchema,
  type AgentExperience,
} from '@werewolf/shared';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client';
import { cosine, validVector } from '../llm/embedding';
import { fingerprint } from '../turn/prompt-comparison';
import { experienceApplicable, approvedExperience } from '../store/experiences';
import { knowledgeApplicable } from '../store/knowledge';
import type { GameStores } from '../store/stores';

const vectorFields = {
  embeddingKey: z.string().min(1),
  vector: z.array(z.number().finite()).min(1),
  createdAt: z.iso.datetime(),
};
export const ReferenceCorpusSchema = z.object({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  hash: z.string(),
  experiences: z.array(z.object({ ...vectorFields, snapshot: ExperienceSnapshotSchema })),
  knowledge: z.array(z.object({ ...vectorFields, snapshot: KnowledgeSnapshotSchema })),
});
export type FrozenReferenceCorpus = z.infer<typeof ReferenceCorpusSchema>;

export function sealCorpus(input: Omit<FrozenReferenceCorpus, 'hash'>): FrozenReferenceCorpus {
  return { ...input, hash: fingerprint(input) };
}

export function assertCorpus(value: unknown): FrozenReferenceCorpus {
  const corpus = ReferenceCorpusSchema.parse(value);
  const { hash, ...body } = corpus;
  if (hash !== fingerprint(body)) throw new Error('参考语料内容与冻结指纹不一致');
  const keys = [
    ...corpus.experiences.map((row) => `experience/${row.snapshot.id}/${row.snapshot.version}`),
    ...corpus.knowledge.map((row) => `knowledge/${row.snapshot.versionId}`),
  ];
  if (new Set(keys).size !== keys.length) throw new Error('参考语料含重复条目');
  for (const row of [...corpus.experiences, ...corpus.knowledge])
    validVector(row.vector, row.vector.length);
  return corpus;
}

/** 只读取当前启用的确切版本；导出后实验不再访问在线知识库。 */
export async function exportReferenceCorpus(db: PrismaClient): Promise<FrozenReferenceCorpus> {
  const [experiences, knowledge] = await Promise.all([
    db.agentExperience.findMany({
      where: { enabled: true, archived: false, embeddingKey: { not: null } },
      orderBy: { id: 'asc' },
    }),
    db.knowledgeVersion.findMany({
      where: { activeFor: { isNot: null }, embeddingKey: { not: null } },
      orderBy: { id: 'asc' },
    }),
  ]);
  const createdAt = new Date().toISOString();
  return sealCorpus({
    version: 1,
    createdAt,
    experiences: experiences
      .filter(
        (row) =>
          row.embedding.length > 0 &&
          approvedExperience({ ...(row.content as AgentExperience), version: row.version }),
      )
      .map((row) => ({
        snapshot: ExperienceSnapshotSchema.parse(row.content),
        embeddingKey: row.embeddingKey!,
        vector: row.embedding,
        // 表中没有完整的编辑及启用时间，当前内容只能保证在导出时可用。
        createdAt,
      })),
    knowledge: knowledge
      .filter((row) => row.embedding.length > 0)
      .map((row) => ({
        snapshot: KnowledgeSnapshotSchema.parse({
          id: row.itemId,
          versionId: row.id,
          version: row.version,
          content: row.content,
        }),
        embeddingKey: row.embeddingKey!,
        vector: row.embedding,
        createdAt,
      })),
  });
}

/** 留出对局整局隔离；不能仅排除正在评分的那一个行动。 */
export function corpusBefore(
  corpus: FrozenReferenceCorpus,
  cutoff: string,
  excludedGames: readonly string[],
) {
  const excluded = new Set(excludedGames);
  return sealCorpus({
    version: 1,
    createdAt: corpus.createdAt,
    experiences: corpus.experiences.filter(
      (row) => row.createdAt <= cutoff && !excluded.has(row.snapshot.sourceGameId),
    ),
    knowledge: corpus.knowledge.filter((row) => row.createdAt <= cutoff),
  });
}

/** 实验只替换检索读口；行动、模型调用与恢复逻辑仍使用原有 stores。 */
export function freezeReferenceStores(
  stores: GameStores,
  source: FrozenReferenceCorpus,
): GameStores {
  const corpus = structuredClone(assertCorpus(source));
  const experienceRows = corpus.experiences.map((row) => ({
    ...row,
    item: {
      ...row.snapshot,
      enabled: true,
      indexed: true,
      archived: false,
      createdAt: row.createdAt,
    } as AgentExperience,
  }));
  return {
    ...stores,
    experiences: {
      ...stores.experiences,
      async hasCandidates(scope) {
        return experienceRows.some((row) => experienceApplicable(row.item, scope));
      },
      async lexicalCandidates(scope, key) {
        return structuredClone(
          experienceRows
            .filter((row) => row.embeddingKey === key && experienceApplicable(row.item, scope))
            .map((row) => row.item),
        );
      },
      async search(scope, key, vector, limit) {
        return experienceRows
          .filter((row) => row.embeddingKey === key && experienceApplicable(row.item, scope))
          .map((row) => ({
            experience: structuredClone(row.item),
            similarity: cosine(row.vector, vector),
          }))
          .toSorted(
            (a, b) => b.similarity - a.similarity || a.experience.id.localeCompare(b.experience.id),
          )
          .slice(0, limit);
      },
    },
    knowledge: {
      ...stores.knowledge,
      async hasCandidates(scope) {
        return corpus.knowledge.some((row) => knowledgeApplicable(row.snapshot, scope));
      },
      async lexicalCandidates(scope, key) {
        return structuredClone(
          corpus.knowledge
            .filter((row) => row.embeddingKey === key && knowledgeApplicable(row.snapshot, scope))
            .map((row) => row.snapshot),
        );
      },
      async search(scope, key, vector, limit) {
        return corpus.knowledge
          .filter((row) => row.embeddingKey === key && knowledgeApplicable(row.snapshot, scope))
          .map((row) => ({
            knowledge: structuredClone(row.snapshot),
            similarity: cosine(row.vector, vector),
          }))
          .toSorted(
            (a, b) => b.similarity - a.similarity || a.knowledge.id.localeCompare(b.knowledge.id),
          )
          .slice(0, limit);
      },
    },
  };
}
