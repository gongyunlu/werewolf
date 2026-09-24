import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { usageObject } from '../llm/observation';
import type { ObservationData, ObservationStore } from './observations';

export function prismaObservations(client: PrismaClient): ObservationStore {
  return {
    read(gameId) {
      return client.$transaction(
        async (tx) => {
          const game = await tx.game.findUnique({
            where: { id: gameId },
            select: { id: true, status: true, winner: true },
          });
          if (!game) return null;
          const calls = await tx.askedPrompt.findMany({
            where: { gameId },
            orderBy: { id: 'asc' },
            select: {
              id: true,
              gameId: true,
              actionKey: true,
              summaryKey: true,
              model: true,
              callId: true,
              executionId: true,
              step: true,
              formatAttempt: true,
              taskId: true,
              checkpointId: true,
              endpointKey: true,
              status: true,
              failureCode: true,
              durationMs: true,
              createdAt: true,
              finishedAt: true,
              traceId: true,
              spanId: true,
              attempts: {
                orderBy: { attemptNo: 'asc' },
                select: {
                  attemptNo: true,
                  status: true,
                  dispatched: true,
                  durationMs: true,
                  usageComplete: true,
                  failureCode: true,
                  thinkingMs: true,
                  httpStatus: true,
                  requestId: true,
                  usage: true,
                  startedAt: true,
                  finishedAt: true,
                  traceId: true,
                  spanId: true,
                },
              },
            },
          });
          const actions = await tx.$queryRaw<ObservationData['actions']>(Prisma.sql`
          SELECT action_key AS "actionKey", actor_id AS "actorId", action_type AS "actionType", status,
            outcome #>> '{snapshot,sourceCallId}' AS "sourceCallId"
          FROM action_records WHERE game_id = ${gameId} ORDER BY action_key
        `);
          return {
            game: { gameId: game.id, status: game.status, winner: game.winner },
            actions,
            calls: calls.map((row) => ({
              ...row,
              attempts: row.attempts.map((attempt) => ({
                ...attempt,
                usage: usageObject(attempt.usage),
              })),
            })),
          };
        },
        { isolationLevel: 'RepeatableRead' },
      );
    },
  };
}
