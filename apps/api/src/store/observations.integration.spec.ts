import { ACTION_TYPES } from '@werewolf/shared';
import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { phaseInstanceId } from '../core/identity';
import { recordingModelPort } from '../llm/recording-model-port';
import { openaiModelPort } from '../llm/openai-model-port';
import { retryingModelPort } from '../llm/retrying-model-port';
import { stubSkills } from '../testing/fixtures';
import { actionKeyOf, type ActionRequest, type TurnRuntime } from '../turn/request';
import { LOCAL_TURN_PROMPTS } from '../turn/prompt';
import { runActionGraph } from '../turn/graph';
import { openPrismaClient, prismaStores } from './prisma';

const databaseUrl = process.env.OBSERVATION_TEST_DATABASE_URL;
const redisPort = Number(process.env.OBSERVATION_TEST_REDIS_PORT ?? 6379);
const integration = databaseUrl ? describe : describe.skip;

integration('Postgres 与 Redis 的离线观测验收', () => {
  it('队列重投恢复失败节点，换连接后仍复用检查点，并保留两次执行的请求记录', async () => {
    const gameId = `observation-test-${randomUUID()}`;
    const input: ActionRequest = {
      scope: { gameId, phaseInstanceId: phaseInstanceId(1, 'vote') },
      actionType: ACTION_TYPES.VOTE,
      actorId: 'p1',
      actionOrdinal: 0,
      preset: 'quality',
      context: {
        task: '投票',
        actor: { playerId: 'p1', seatNo: 1, role: '村民' },
        day: 1,
        visible: [],
        options: [],
        skill: [],
      },
      schema: z.number(),
    };
    const connection = { host: '127.0.0.1', port: redisPort };
    const queue = new Queue(gameId, { connection });
    let client = openPrismaClient(databaseUrl!);
    let worker: Worker | undefined;
    let requests = 0;
    let first = true;
    try {
      const initial = prismaStores(client);
      await initial.games.open({ gameId, boardId: 'test', roster: [] });
      await initial.asked.append(gameId, {
        actionKey: null,
        model: 'legacy',
        system: '旧正文',
        prompt: '旧题面',
      });
      await initial.actions.begin({
        gameId,
        actionKey: actionKeyOf(input),
        phaseInstanceId: input.scope.phaseInstanceId,
        actionType: input.actionType,
        actorId: input.actorId,
        actionOrdinal: 0,
        ledgerSeq: 0,
      });
      const job = await queue.add(
        'check',
        {},
        { attempts: 2, backoff: { type: 'fixed', delay: 20 } },
      );
      const completed = new Promise<void>((resolve, reject) => {
        worker = new Worker(
          gameId,
          async () => {
            const stores = prismaStores(client);
            const port = recordingModelPort(
              retryingModelPort(
                openaiModelPort({
                  fetch: async () => {
                    requests++;
                    if (requests === 2) return new Response('拒绝请求', { status: 401 });
                    const value = requests === 1 ? 2 : { accept: true, issues: '' };
                    return new Response(
                      JSON.stringify({
                        choices: [
                          {
                            finish_reason: 'tool_calls',
                            message: {
                              tool_calls: [
                                {
                                  function: {
                                    name: 'submit',
                                    arguments: JSON.stringify({ value }),
                                  },
                                },
                              ],
                            },
                          },
                        ],
                        usage: { total_tokens: 5 },
                      }),
                      { headers: { 'content-type': 'application/json' } },
                    );
                  },
                }),
                { backoffMs: 0 },
              ),
              (asked) => stores.asked.append(gameId, { ...asked, actionKey: actionKeyOf(input) }),
            );
            const runtime: TurnRuntime = {
              port,
              accessFor: () => ({
                baseUrl: 'http://offline.invalid',
                model: 'test',
                apiKey: 'not-a-key',
                capability: { reasoningOff: null },
              }),
              memoriesFor: () => [],
              skills: stubSkills(),
              promptSource: LOCAL_TURN_PROMPTS,
            };
            const resume = !first;
            first = false;
            try {
              const outcome = await runActionGraph(runtime, input, {
                saver: stores.checkpoints,
                resume,
              });
              await stores.actions.finish(actionKeyOf(input), outcome);
              const again = await runActionGraph(runtime, input, {
                saver: stores.checkpoints,
                resume: true,
              });
              expect(again).toEqual(outcome);
            } catch (error) {
              await client.$disconnect();
              client = openPrismaClient(databaseUrl!);
              throw error;
            }
          },
          { connection },
        );
        worker.on('completed', () => resolve());
        worker.on('failed', (failed, error) => {
          if (failed?.attemptsMade === 2) reject(error);
        });
        worker.on('error', reject);
      });
      await completed;
      const data = (await prismaStores(client).observations.read(gameId))!;
      expect(requests).toBe(3);
      expect(data.calls).toHaveLength(4);
      expect(data.calls[0]).toMatchObject({ callId: null, status: null, attempts: [] });
      expect(data.calls.slice(1).map((row) => row.attempts.length)).toEqual([1, 1, 1]);
      expect(data.actions[0].sourceCallId).toBe(data.calls[1].callId);
      expect(data.calls[2].taskId).toBe(data.calls[3].taskId);
      expect(data.calls[2].executionId).not.toBe(data.calls[3].executionId);
      expect(JSON.stringify(data)).not.toContain('旧正文');
      expect((await queue.getJob(job.id!))?.attemptsMade).toBe(2);
      await expect(
        client.modelAttempt.create({ data: { askedPromptId: data.calls[1].id, attemptNo: 1 } }),
      ).rejects.toMatchObject({ code: 'P2002' });
      await client.game.delete({ where: { id: gameId } });
      expect(
        await client.modelAttempt.count({
          where: { askedPromptId: { in: data.calls.map((row) => row.id) } },
        }),
      ).toBe(0);
    } finally {
      await worker?.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await client.game.deleteMany({ where: { id: gameId } });
      await client.$disconnect();
    }
  }, 30_000);
});
