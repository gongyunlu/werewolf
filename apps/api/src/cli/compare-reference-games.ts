import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { seatContextOf } from '../agents/seat-context';
import { ALL_BOARDS, BOARD_IDS, handOf } from '../boards/boards';
import { loadEnv } from '../config/env';
import { loadEnvFiles } from '../config/env-files';
import { DEALABLE_ROLES } from '../core/roles';
import {
  referenceGameFixtures,
  referenceGameSummary,
  runReferenceGameExperiment,
  type ReferenceGameResult,
} from '../evaluation/game-experiment';
import {
  assertCorpus,
  exportReferenceCorpus,
  freezeReferenceStores,
  type FrozenReferenceCorpus,
} from '../evaluation/reference-corpus';
import { RETRIEVAL_POLICY } from '../experience/retrieval-ranking';
import { embeddingKey, embeddingRuntime } from '../llm/embedding';
import { modelRuntimeOf, promptSourceOf } from '../llm/from-env';
import { observeOperation, startTelemetry, stopTelemetry, telemetry } from '../llm/telemetry';
import { TURN_PROMPT_NAMES, loadPrompt } from '../prompts/catalog';
import { snapshotPromptSource } from '../prompts/template';
import { gameSkills, type GameSkills, type ScenarioId } from '../skills/game-skills';
import { memoryStores } from '../store/memory';
import { openPrismaClient, prismaStores } from '../store/prisma';
import { fingerprint } from '../turn/prompt-comparison';
import { runModelGame, type ModelGameResult } from '../turn/run-model-game';

const modeSchema = z.enum(['none', 'vector', 'hybrid']);
const configSchema = z
  .object({
    boardId: z.enum(BOARD_IDS),
    seeds: z.array(z.number().int().safe()).min(1),
    testedAgentId: z.uuid(),
    opponentAgentIds: z.array(z.uuid()).min(1),
    seatNos: z.array(z.number().int().positive()).min(1).optional(),
    repetitions: z.number().int().positive().default(1),
    baseline: modeSchema.default('vector'),
    candidate: modeSchema.default('hybrid'),
  })
  .strict();

const scenarios: readonly ScenarioId[] = [
  'day_speech',
  'vote',
  'night_action',
  'sheriff_decide_order',
  'wolf_team',
  'wolf_discussion',
];

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      corpus: { type: 'string' },
      output: { type: 'string' },
      run: { type: 'boolean', default: false },
    },
  });
  if (!values.config)
    throw new Error(
      '用法：references:games --config <配置.json> [--corpus <固定语料.json>] [--output <目录>] [--run]',
    );
  const config = configSchema.parse(JSON.parse(await readFile(values.config, 'utf8')));
  const seatCount = handOf(ALL_BOARDS[config.boardId]).length;
  if (config.opponentAgentIds.length !== seatCount - 1)
    throw new Error(`该板子需要 ${seatCount - 1} 个固定对手`);
  const experimentId = `references-${randomUUID()}`;
  const fixtures = referenceGameFixtures({ ...config, experimentId });
  loadEnvFiles();
  const env = loadEnv();
  const db = openPrismaClient(env.DATABASE_URL);
  try {
    const stores = prismaStores(db);
    const agentIds = [config.testedAgentId, ...config.opponentAgentIds];
    const agents = await stores.agents.findMany([...new Set(agentIds)]);
    const participants = agentIds.map((id, index) => {
      const agent = agents.find((row) => row.id === id);
      if (!agent?.isActive) throw new Error(`参赛 agent 不存在或未启用：${id}`);
      return {
        seatNo: index + 1,
        agentId: id,
        name: agent.name,
        modelName: agent.modelName,
        baseUrl: agent.baseUrl,
      };
    });
    const { port, access } = modelRuntimeOf(env);
    const seatContext = await seatContextOf({
      env,
      roster: participants,
      agents: stores.agents,
      fallback: access,
    });
    const accesses = participants.map((participant) =>
      structuredClone(seatContext.accessFor(participant.seatNo)),
    );
    const memories = participants.map((participant) => [
      ...seatContext.memoriesFor(participant.seatNo),
    ]);
    const corpus: FrozenReferenceCorpus = values.corpus
      ? JSON.parse(await readFile(values.corpus, 'utf8'))
      : await exportReferenceCorpus(db);
    assertCorpus(corpus);
    const embedding = embeddingRuntime(env);
    const sourcePrompts = promptSourceOf(env);
    const prompts = await Promise.all(
      Object.values(TURN_PROMPT_NAMES).map((name) => loadPrompt(sourcePrompts, name)),
    );
    const promptSource = snapshotPromptSource(prompts);
    const sourceSkills = gameSkills(config.boardId);
    const skillSnapshot = structuredClone({
      common: sourceSkills.common,
      ruleset: sourceSkills.ruleset,
      roles: DEALABLE_ROLES.map((role) => ({ role, skill: sourceSkills.role(role) })),
      scenarios: scenarios.map((id) => ({ id, skill: sourceSkills.scenario(id) })),
    });
    const skills: GameSkills = {
      common: skillSnapshot.common,
      ruleset: skillSnapshot.ruleset,
      role: (role) => skillSnapshot.roles.find((entry) => entry.role === role)!.skill,
      scenario: (id) => skillSnapshot.scenarios.find((entry) => entry.id === id)!.skill,
    };
    const conditions = {
      config,
      ruleSet: ALL_BOARDS[config.boardId],
      skills: skillSnapshot,
      prompts,
      corpusHash: corpus.hash,
      embeddingKey: embeddingKey(embedding),
      retrievalPolicy: RETRIEVAL_POLICY,
      participants: participants.map((participant, index) => ({
        ...participant,
        baseUrl: accesses[index]!.baseUrl,
        capability: accesses[index]!.capability,
        memories: memories[index],
      })),
      summaryModel: { baseUrl: access.baseUrl, model: access.model, capability: access.capability },
      modelRequest: { timeoutMs: env.MODEL_REQUEST_TIMEOUT_MS, attempts: env.MODEL_MAX_ATTEMPTS },
      opponentReferenceMode: 'none',
      minute: 0,
      release: env.LANGFUSE_RELEASE,
    };
    const conditionsHash = fingerprint(conditions);
    const directory = resolve(values.output ?? `docs/reference-game-experiments/${experimentId}`);
    await mkdir(directory, { recursive: true });
    const save = (name: string, value: unknown) =>
      writeFile(resolve(directory, name), JSON.stringify(value, null, 2), 'utf8');
    await Promise.all([
      save('conditions.json', { conditionsHash, ...conditions }),
      save('corpus.json', corpus),
      save('fixtures.json', fixtures),
    ]);
    Logger.log(
      `固定输入已保存：${directory}；共 ${fixtures.length} 对、${fixtures.length * 2} 局。`,
    );
    if (!values.run) {
      Logger.log('预览完成，模型调用 0 次；加 --run 执行对局。');
      return;
    }
    startTelemetry(env);
    const partial: ReferenceGameResult[] = [];
    const results = await runReferenceGameExperiment({
      fixtures,
      conditionsHash,
      async run(trial) {
        const gameStores = freezeReferenceStores(memoryStores(), corpus);
        let opponentIndex = 1;
        const indices = trial.setup.seats.map((seat) =>
          seat.seatNo === trial.fixture.testedSeatNo ? 0 : opponentIndex++,
        );
        const roster = trial.setup.seats.map((seat, index) => ({
          ...participants[indices[index]!]!,
          seatNo: seat.seatNo,
        }));
        await gameStores.games.open({
          gameId: trial.setup.gameId,
          boardId: config.boardId,
          roster,
        });
        return observeOperation(
          'references.game-experiment',
          'chain',
          {
            input: { setup: trial.setup, testedSeatNo: trial.fixture.testedSeatNo },
            metadata: {
              experimentId,
              conditionsHash,
              variant: trial.variant,
              referenceMode: trial.mode,
            },
          },
          async (span) => {
            let result: ModelGameResult | undefined;
            try {
              result = await runModelGame({
                setup: trial.setup,
                playerIds: trial.setup.seats.map((seat) => `p${seat.seatNo}`),
                runtime: {
                  port,
                  embedding,
                  accessFor: (seatNo) =>
                    seatNo === null ? access : accesses[indices[seatNo - 1]!]!,
                  memoriesFor: (seatNo) => memories[indices[seatNo - 1]!]!,
                  skills,
                  referenceModeFor: (seatNo) =>
                    seatNo === trial.fixture.testedSeatNo ? trial.mode : 'none',
                },
                promptSource,
                stores: gameStores,
                minuteOf: () => 0,
              });
              const tested = result.state.players.find(
                (player) => player.seatNo === trial.fixture.testedSeatNo,
              )!;
              const outcome = {
                winner: result.winner,
                testedFaction: tested.faction,
                actionCount: result.outcomes.length,
              };
              telemetry(() => span?.update({ output: outcome }));
              return outcome;
            } finally {
              const [actions, events, lastStage] = await Promise.all([
                gameStores.actions.list(trial.setup.gameId),
                gameStores.events.list(trial.setup.gameId),
                gameStores.steps.last(trial.setup.gameId),
              ]);
              await save(`${trial.setup.gameId}.json`, {
                status: result ? 'completed' : 'failed',
                setup: trial.setup,
                roster,
                winner: result?.winner ?? null,
                finalState: result?.state ?? null,
                actions,
                events,
                lastStage,
              });
            }
          },
          { sessionId: trial.setup.gameId },
        );
      },
      async onResult(result) {
        partial.push(result);
        await save('results.json', partial);
        Logger.log(
          `已完成 ${partial.length}/${fixtures.length * 2} 局：${result.gameId}，被测玩家${result.won ? '获胜' : '落败'}。`,
        );
      },
    });
    const summary = referenceGameSummary(results);
    await save('summary.json', {
      conditionsHash,
      description:
        '固定对手池；每局只计被测玩家。95% 区间为各组胜率的 Wilson 区间，不是两组差异的显著性检验。',
      groups: summary,
    });
    Logger.log(JSON.stringify(summary, null, 2));
  } finally {
    await Promise.all([db.$disconnect(), stopTelemetry()]);
  }
}

void main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : '对局对照失败');
  process.exitCode = 1;
});
