import type { AgentExperience } from '@werewolf/shared';
import { Prisma, type PrismaClient } from '../generated/prisma/client';
import {
  experienceRows,
  initialExperienceState,
  type ExperienceGeneration,
  type ExperienceState,
  type ExperienceStore,
} from './experiences';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const generation = (row: Prisma.ExperienceGenerationModel): ExperienceGeneration => ({
  ...row,
  state: row.state as unknown as ExperienceState,
});
const experience = (row: Prisma.AgentExperienceModel): AgentExperience => ({
  ...(row.content as unknown as AgentExperience),
  enabled: row.enabled,
  indexed: row.embedding.length > 0,
  createdAt: row.createdAt.toISOString(),
});

export function prismaExperiences(client: PrismaClient): ExperienceStore {
  return {
    async hasCandidates({ boardId, role, gameId }) {
      return (
        (await client.agentExperience.count({
          where: {
            boardId,
            role,
            enabled: true,
            generation: { gameId: { not: gameId } },
          },
        })) > 0
      );
    },
    async search({ boardId, role, gameId }, key, vector, limit) {
      // PostgreSQL 精确余弦检索，先过滤适用范围，只返回有界候选；不把全库向量搬到应用层。
      const rows = await client.$queryRaw<Array<{ content: unknown; similarity: number }>>`
        SELECT e.content,
          (SELECT sum(v.x * q.x) / NULLIF(sqrt(sum(v.x * v.x) * sum(q.x * q.x)), 0)
           FROM unnest(e.embedding) WITH ORDINALITY AS v(x, i)
           JOIN unnest(${vector}::double precision[]) WITH ORDINALITY AS q(x, i) USING (i)) AS similarity
        FROM agent_experiences e JOIN experience_generations g ON g.id = e.generation_id
        WHERE e.enabled = true AND e.board_id = ${boardId} AND e.role = ${role}
          AND g.game_id <> ${gameId} AND e.embedding_key = ${key}
          AND cardinality(e.embedding) = ${vector.length}
        ORDER BY similarity DESC, e.id ASC LIMIT ${limit}
      `;
      return rows.map((row) => ({
        experience: row.content as AgentExperience,
        similarity: row.similarity,
      }));
    },
    async writeVectors(key, rows) {
      await client.$transaction(
        rows.map((row) =>
          client.agentExperience.update({
            where: { id: row.id },
            data: { embedding: row.vector, embeddingKey: key },
          }),
        ),
      );
    },
    async list(agentId) {
      return (
        await client.agentExperience.findMany({
          where: { agentId },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        })
      ).map(experience);
    },
    async toggle(agentId, id, enabled) {
      return (
        (await client.agentExperience.updateMany({ where: { id, agentId }, data: { enabled } }))
          .count === 1
      );
    },
    async findSource(gameId, playerId, reviewVersion) {
      const row = await client.experienceGeneration.findUnique({
        where: { gameId_playerId_reviewVersion: { gameId, playerId, reviewVersion } },
      });
      return row ? generation(row) : null;
    },
    async findGeneration(id) {
      const row = await client.experienceGeneration.findUnique({ where: { id } });
      return row ? generation(row) : null;
    },
    async open(input) {
      const { gameId, playerId, reviewVersion } = input;
      return generation(
        await client.experienceGeneration.upsert({
          where: { gameId_playerId_reviewVersion: { gameId, playerId, reviewVersion } },
          create: { ...input, state: json(initialExperienceState()) },
          update: {},
        }),
      );
    },
    async save(row, next) {
      const saved = await client.experienceGeneration.updateMany({
        where: { id: row.id, state: { equals: json(row.state) } },
        data: { state: json(next) },
      });
      if (saved.count !== 1) throw new Error('经验任务状态已变化，请刷新后重试');
    },
    async complete(row, result) {
      await client.$transaction(async (tx) => {
        const saved = await tx.experienceGeneration.updateMany({
          where: { id: row.id, state: { equals: json(row.state) } },
          data: { state: json({ ...row.state, status: 'completed', failure: null, result }) },
        });
        if (saved.count !== 1) throw new Error('经验任务状态已变化，请刷新后重试');
        const rows = experienceRows(row, result);
        if (rows.length)
          await tx.agentExperience.createMany({
            data: rows.map((item, ordinal) => ({
              id: item.id,
              agentId: item.agentId,
              generationId: item.generationId,
              boardId: item.boardId,
              role: item.role,
              ordinal,
              content: json(item),
            })),
          });
      });
    },
  };
}
