import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { usageObject } from '../llm/observation';
import type { ExecutionRow, ObservationData, ObservationStore } from './observations';

export function prismaObservations(client: PrismaClient): ObservationStore {
  return {
    progress(gameId, phaseInstanceId) {
      return client.$queryRaw<ExecutionRow[]>(Prisma.sql`
        SELECT a.action_key AS "actionKey", a.actor_id AS "actorId", a.action_type AS "actionType", a.status,
          c.step, c.status AS "callStatus", c.failure_code AS "failureCode",
          m.attempt_no AS "attemptNo", m.status AS "attemptStatus", m.started_at AS "startedAt",
          m.finished_at AS "finishedAt", m.failure_code AS "attemptFailureCode"
        FROM action_records a
        LEFT JOIN LATERAL (
          SELECT id, step, status, failure_code FROM asked_prompts
          WHERE game_id = a.game_id AND action_key = a.action_key AND a.status = 'running'
          ORDER BY id DESC LIMIT 1
        ) c ON true
        LEFT JOIN LATERAL (
          SELECT attempt_no, status, started_at, finished_at, failure_code FROM model_attempts
          WHERE asked_prompt_id = c.id ORDER BY attempt_no DESC LIMIT 1
        ) m ON true
        WHERE a.game_id = ${gameId} AND a.phase_instance_id = ${phaseInstanceId}
        ORDER BY a.created_at, a.action_key
      `);
    },
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
