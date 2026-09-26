import { BadRequestException } from '@nestjs/common';
import { ExperienceResultSchema, type ExperienceResult } from '@werewolf/shared';
import { randomUUID } from 'node:crypto';
import { seatContextOf } from '../agents/seat-context';
import { loadEnv } from '../config/env';
import { modelRuntimeOf, promptSourceOf } from '../llm/from-env';
import {
  InvalidOutputError,
  ModelCallError,
  type ModelAccess,
  type ModelPort,
  type ModelResponse,
} from '../llm/model-port';
import type { PromptSource } from '../llm/prompt-template';
import { recordingModelPort } from '../llm/recording-model-port';
import { readReview, readReviewState } from '../review/workflow';
import { REVIEW_VERSION } from '../review/contracts';
import { finishedGame } from '../review/evidence';
import type { ExperienceGeneration, ExperienceInput, ExperienceState } from '../store/experiences';
import type { GameStores } from '../store/stores';
import { parseStructured } from '../turn/graph';
import {
  experiencePrompts,
  experienceRequest,
  experienceTool,
  resolveExperienceSources,
} from './prompt';

export async function experienceSource(stores: GameStores, gameId: string, playerId: string) {
  const game = await finishedGame(stores, gameId);
  const player = game.finalState!.players.find((item) => item.id === playerId);
  if (!player) throw new BadRequestException('这局没有该玩家');
  const seat = game.roster.find((item) => item.seatNo === player.seatNo);
  if (!seat)
    return { reason: '该历史玩家没有绑定持久 agent，不能生成个人经验', game, player, seat: null };
  const review = await readReviewState(stores, gameId);
  const reason = !review?.completedAt
    ? '请先完成本局复盘'
    : !review.receipts.some((item) => item.key === `player/${playerId}`)
      ? '该玩家没有已完成的个人复盘'
      : null;
  return { reason, game, player, seat };
}

export async function prepareExperience(
  stores: GameStores,
  row: ExperienceGeneration,
  source: PromptSource,
): Promise<ExperienceInput> {
  const eligible = await experienceSource(stores, row.gameId, row.playerId);
  if (eligible.reason || !eligible.seat) throw new BadRequestException(eligible.reason);
  if (eligible.seat.agentId !== row.agentId) throw new Error('来源阵容与经验归属不一致');
  const report = await readReview(stores, row.gameId);
  if (!report?.completedAt || report.version !== row.reviewVersion)
    throw new Error('来源复盘版本不一致');
  const own = report.evidence.targets.filter((item) => item.actorId === row.playerId);
  // 只把本人行动快照标为当时材料。完整事件与终局知识全部标为赛后，不猜旁观权限。
  const sources = [
    ...own.flatMap((item) =>
      item.sources.map((entry) => ({ ...entry, perspective: 'at_action' as const })),
    ),
    ...report.evidence.omniscient
      .filter((entry) => !('actionKey' in entry.origin))
      .map((entry) => ({ ...entry, perspective: 'post_game' as const })),
  ];
  const unique = [...new Map(sources.map((entry) => [entry.id, entry])).values()];
  return {
    boardId: eligible.game.boardId,
    role: eligible.player.role,
    seat: eligible.seat,
    review: report.players.find((item) => item.playerId === row.playerId)!.result,
    sources: unique,
    prompts: await experiencePrompts(source),
  };
}

interface ExperienceRuntime {
  port: ModelPort;
  access: ModelAccess;
  promptSource: PromptSource;
  prepare?: (row: ExperienceGeneration) => Promise<ExperienceInput>;
}

export async function runExperience(stores: GameStores, id: string, provided?: ExperienceRuntime) {
  let row = await stores.experiences.findGeneration(id);
  if (!row) throw new Error('经验生成任务不存在');
  if (row.state.status === 'completed') return;
  // 可能仍有原 worker 在等待答复；读取者不能改写它的认领状态。
  if (row.state.attempts.at(-1)?.status === 'pending')
    throw new Error('上次请求结果未知；为避免重复调用，已停止自动重发，请核查调用记录');
  const save = async (patch: Partial<ExperienceState>) => {
    const state = { ...row!.state, ...patch };
    await stores.experiences.save(row!, state);
    row = { ...row!, state };
  };
  try {
    await save({ status: 'running', failure: null });
    const promptSource = provided?.promptSource ?? promptSourceOf(loadEnv());
    if (!row.state.input)
      await save({
        input: provided?.prepare
          ? await provided.prepare(row)
          : await prepareExperience(stores, row, promptSource),
      });
    const input = row.state.input!;
    let runtime = provided;
    const request = experienceRequest(input);
    const tool = experienceTool(input);
    while (true) {
      let completeObservation: import('../llm/model-port').ModelResponse['completeObservation'];
      let attempt = row.state.attempts.at(-1);
      if (attempt?.status === 'pending')
        throw new Error('上次请求结果未知；为避免重复调用，已停止自动重发，请核查调用记录');
      if (!attempt || attempt.status === 'invalid' || attempt.status === 'failed') {
        if (row.state.attempts.filter((item) => item.status === 'invalid').length >= 3)
          throw new Error('模型连续三次输出不符合结构或来源约束，已停止重试');
        if (!runtime) {
          const env = loadEnv();
          const fallback = modelRuntimeOf(env);
          const seats = await seatContextOf({
            env,
            roster: [input.seat],
            agents: stores.agents,
            fallback: fallback.access,
          });
          runtime = { ...fallback, access: seats.accessFor(input.seat.seatNo), promptSource };
        }
        const callId = randomUUID();
        const note = row.state.attempts.findLast((item) => item.diagnosis)?.diagnosis;
        attempt = { callId, status: 'pending', citationFormat: 'short_ids' };
        await save({ attempts: [...row.state.attempts, attempt] });
        const started = performance.now();
        const port = recordingModelPort(
          runtime.port,
          (asked) =>
            stores.asked.append(row!.gameId, {
              ...asked,
              actionKey: null,
              summaryKey: `experience/${id}`,
            }),
          { gameId: row.gameId, actionKey: null, summaryKey: `experience/${id}` },
        );
        let response;
        let received: ModelResponse | undefined;
        try {
          response = await port.generate(
            {
              ...request,
              tool,
              prompt:
                request.prompt +
                (note ? `\n上次输出的结构问题：${note}。请通过工具重新提交。` : ''),
            },
            runtime.access,
            {
              identity: {
                callId,
                executionId: id,
                step: 'experience',
                formatAttempt: row.state.attempts.length,
              },
              onResponse: (value) => {
                received = value;
              },
            },
          );
        } catch (error) {
          // 明确返回的失败可以重试；记录层写入失败或进程中断不能当作未调用。
          if (received)
            await save({
              attempts: [
                ...row.state.attempts.slice(0, -1),
                {
                  ...attempt,
                  status: 'responded',
                  durationMs: performance.now() - started,
                  response: {
                    content: received.content,
                    toolCall: received.toolCall,
                    reasoning: received.reasoning,
                  },
                },
              ],
            });
          else if (error instanceof ModelCallError)
            await save({
              attempts: [...row.state.attempts.slice(0, -1), { ...attempt, status: 'failed' }],
            });
          throw error instanceof ModelCallError
            ? new Error(`经验模型请求失败（${error.code}），可续跑`)
            : error;
        }
        completeObservation = response.completeObservation;
        attempt = {
          ...attempt,
          status: 'responded',
          durationMs: performance.now() - started,
          response: {
            content: response.content,
            toolCall: response.toolCall,
            reasoning: response.reasoning,
          },
        };
        // 先存原答复。后面的校验、观测收尾或事务失败时，只读这份，不再问模型。
        await save({ attempts: [...row.state.attempts.slice(0, -1), attempt] });
      }
      let result: ExperienceResult;
      try {
        if (!attempt.response?.toolCall)
          throw new InvalidOutputError('没有工具结果', '没有通过工具提交');
        result = parseStructured(
          attempt.response.toolCall.arguments,
          ExperienceResultSchema,
          '个人经验',
        );
        result = resolveExperienceSources(input, result, attempt.citationFormat === 'short_ids');
      } catch (error) {
        if (!(error instanceof InvalidOutputError)) throw error;
        if (completeObservation) await completeObservation('invalid_output');
        else
          await stores.asked.finishCall(attempt.callId, {
            status: 'invalid_output',
            failureCode: 'invalid_output',
            durationMs: attempt.durationMs ?? 0,
          });
        await save({
          attempts: [
            ...row.state.attempts.slice(0, -1),
            { ...attempt, status: 'invalid', diagnosis: error.diagnosis },
          ],
        });
        continue;
      }
      if (completeObservation) await completeObservation('accepted');
      else
        await stores.asked.finishCall(attempt.callId, {
          status: 'accepted',
          failureCode: null,
          durationMs: attempt.durationMs ?? 0,
        });
      await save({
        attempts: [...row.state.attempts.slice(0, -1), { ...attempt, status: 'accepted' }],
      });
      await stores.experiences.complete(row, result);
      return;
    }
  } catch (error) {
    const failure =
      error instanceof Error &&
      (error.message.startsWith('上次请求') ||
        error.message.startsWith('模型连续') ||
        error.message.startsWith('经验模型'))
        ? error.message
        : '经验生成或保存失败；已保存的答复会在续跑时复用，请查看服务端执行记录';
    await save({ status: 'failed', failure });
    throw error;
  }
}

export { REVIEW_VERSION };
