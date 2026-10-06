import { randomUUID } from 'node:crypto';
import type { ExperienceResult } from '@werewolf/shared';
import { memoryStores } from '../store/memory';
import { LOCAL_PROMPTS } from '../prompts/catalog';
import type { ModelPort } from '../llm/model-port';
import { responseOf } from '../testing/model';
import { experiencePrompts } from './prompt';
import { REVIEW_VERSION } from './workflow';
import type { ExperienceInput } from '../store/experiences';
import type { GameStores } from '../store/stores';
import { embeddingKey } from '../llm/embedding';

export const result: ExperienceResult = {
  experiences: [
    {
      title: '核对主张的发生时点',
      body: '先核对行为先后，再判断解释是否得到证据支持；公开说法仍可能是伪装。',
      conditions: '出现用后来的信息解释更早行动的情况时',
      sourceIds: ['E1'],
      actionTypes: ['speech', 'vote'],
      minDay: 1,
      firstDayOnly: false,
      exclusions: '只有赛后信息、没有当时可见依据时不适用。',
    },
  ],
  reason: '保留一条可复核的时序经验',
};
export const access = {
  baseUrl: 'https://example.test/v1',
  model: '离线模型',
  apiKey: '测试',
  capability: { reasoningOff: null },
};
export const promptSource = LOCAL_PROMPTS;

export function failNextAttemptObservation(stores: GameStores) {
  const append = stores.asked.append.bind(stores.asked);
  jest.spyOn(stores.asked, 'append').mockImplementationOnce(async (...args) => ({
    ...(await append(...args))!,
    async finishAttempt() {
      throw new Error('模拟用量写入失败');
    },
  }));
}

export function vectorRuntime(
  vector: number[] | ((text: string) => number[]) = [1, 0],
): import('../llm/embedding').EmbeddingRuntime {
  return {
    access,
    dimensions: 2,
    port: {
      generate: jest.fn(async (request, _access, call) => {
        const attempt = await call?.startAttempt?.();
        attempt?.dispatched();
        const response = {
          content: '',
          toolCall: null,
          reasoning: null,
          vector: typeof vector === 'function' ? vector(request.prompt) : vector,
        };
        call?.onResponse?.(response);
        await attempt?.finish({
          status: 'succeeded',
          dispatched: true,
          failureCode: null,
          durationMs: 1,
          thinkingMs: null,
          httpStatus: 200,
          requestId: 'offline-vector',
          usage: { prompt_tokens: 8, total_tokens: 8 },
          usageComplete: true,
        });
        return response;
      }),
    },
  };
}

export async function approveExperience(
  stores: GameStores,
  id: string,
  runtime: import('../llm/embedding').EmbeddingRuntime,
) {
  const row = (await stores.experiences.find(id))!;
  await stores.experiences.review(row.item.agentId, id, {
    revision: row.item.revision ?? 0,
    version: row.item.version,
    decision: 'approved',
    note: '离线用例已核对来源与适用范围。',
    sourceIds: row.item.sourceIds,
  });
  await stores.experiences.toggle(
    row.item.agentId,
    id,
    true,
    (row.item.revision ?? 0) + 1,
    embeddingKey(runtime),
  );
}

export async function fixture(stores: GameStores = memoryStores()) {
  const gameId = `experience-test-${randomUUID()}`;
  const agent = await stores.agents.create({
    name: gameId,
    modelName: '离线模型',
    baseUrl: null,
    apiKeyCiphertext: null,
    apiKeyHint: null,
    tag: null,
    notes: null,
  });
  const seat = {
    seatNo: 1,
    agentId: agent.id,
    name: agent.name,
    modelName: agent.modelName,
    baseUrl: null,
  };
  await stores.games.open({ gameId, boardId: '6p_white_wolf', roster: [seat] });
  const row = await stores.experiences.open({
    id: randomUUID(),
    agentId: agent.id,
    gameId,
    playerId: 'p1',
    reviewVersion: REVIEW_VERSION,
  });
  const input: ExperienceInput = {
    boardId: '6p_white_wolf',
    role: 'villager',
    seat,
    review: { text: '复盘意见' },
    sources: [
      {
        id: 'source-1',
        origin: { actionKey: 'old-action', path: 'context/visible' },
        value: '原始发言中的时序',
        perspective: 'at_action',
      },
    ],
    prompts: await experiencePrompts(promptSource),
  };
  return { stores, gameId, agent, seat, row, input, prepare: async () => input };
}

/** 记录传输状态的离线端口，用于实际输入与用量链路验证。 */
export function controlledPort(
  answer: string | ((request: import('../llm/model-port').ModelRequest) => string),
): ModelPort {
  return {
    async generate(request, _access, call) {
      const attempt = await call?.startAttempt?.();
      attempt?.dispatched();
      const response = responseOf(request, typeof answer === 'string' ? answer : answer(request));
      call?.onResponse?.(response);
      await attempt?.finish({
        status: 'succeeded',
        dispatched: true,
        failureCode: null,
        durationMs: 1,
        thinkingMs: null,
        httpStatus: 200,
        requestId: 'offline',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        usageComplete: true,
      });
      return response;
    },
  };
}
