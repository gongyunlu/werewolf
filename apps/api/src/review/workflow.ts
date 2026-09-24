import {
  END,
  START,
  StateGraph,
  StateSchema,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ModelAccess, ModelPort } from '../llm/model-port';
import { endpointOf } from '../llm/model-capability';
import { recordingModelPort } from '../llm/recording-model-port';
import type { GameStores } from '../store/stores';
import { claimsOf, REVIEW_VERSION, type Assessment, type ReviewStep } from './contracts';
import { prepareEvidence, type EvidenceSource, type ReviewEvidence } from './evidence';
import { judgeReview } from './judge';

export interface Evaluation {
  assessment: Assessment;
  callId: string;
  model: string;
}
export interface PlayerReview {
  playerId: string;
  evaluatedDecisions: number;
  limitation: string | null;
  result: Evaluation | null;
}
export interface JudgeProfile {
  model: string;
  endpointKey: string;
  capability: ModelAccess['capability'];
}
export function judgeProfile(access: ModelAccess): JudgeProfile {
  return {
    model: access.model,
    endpointKey: createHash('sha256').update(endpointOf(access.baseUrl)).digest('hex'),
    capability: access.capability,
  };
}

interface PreparedReview {
  evidence: ReviewEvidence;
  judge: JudgeProfile;
  version: string;
  startedAt: string;
}
const PreparedState = new StateSchema({
  prepared: z.custom<PreparedReview | null>().default(null),
});
const PrepareContext = z.object({ gameId: z.string(), judge: z.custom<JudgeProfile>() });

const ReviewState = new StateSchema({
  decisions: z.array(z.custom<Evaluation>()).default(() => []),
  players: z.array(z.custom<PlayerReview>()).default(() => []),
  outcome: z.custom<Evaluation | null>().default(null),
  completedAt: z.string().nullable().default(null),
});
export type ReviewReport = PreparedReview & typeof ReviewState.State;
const Runtime = z.object({
  port: z.custom<ModelPort>(),
  access: z.custom<ModelAccess>(),
  evidence: z.custom<ReviewEvidence>(),
});
type ReviewConfig = LangGraphRunnableConfig<z.infer<typeof Runtime>>;

function configOf(gameId: string, archive = false) {
  return {
    configurable: {
      thread_id: JSON.stringify([gameId, 'review', REVIEW_VERSION, archive ? 'evidence' : 'run']),
    },
  };
}

/** 整局证据只冻结一次，不随每个评价节点反复写入检查点。 */
function preparationGraph(stores: GameStores) {
  return new StateGraph(PreparedState, { context: PrepareContext })
    .addNode(
      'prepare',
      async (_state, config: LangGraphRunnableConfig<z.infer<typeof PrepareContext>>) => ({
        prepared: {
          evidence: await prepareEvidence(stores, config.context!.gameId),
          judge: config.context!.judge,
          version: REVIEW_VERSION,
          startedAt: new Date().toISOString(),
        },
      }),
    )
    .addEdge(START, 'prepare')
    .addEdge('prepare', END)
    .compile({ checkpointer: stores.checkpoints });
}

/** 玩家汇总只读局部判断；每项判断仍能沿 refs 找到原始快照。 */
function playerSources(
  state: typeof ReviewState.State,
  evidence: ReviewEvidence,
  playerId: string,
): EvidenceSource[] {
  return evidence.targets.flatMap((target, index) =>
    target.actorId === playerId
      ? claimsOf(state.decisions[index]!.assessment).map(({ path, claim }) => ({
          id: `${evidence.gameId}/assessment/${encodeURIComponent(target.actionKey)}/${path}`,
          origin: { actionKey: target.actionKey, path: `review/${path}` },
          value: claim,
        }))
      : [],
  );
}

function reviewGraph(stores: GameStores) {
  return new StateGraph(ReviewState, { context: Runtime })
    .addNode('evaluate', async (state, config: ReviewConfig) => {
      const runtime = config.context!;
      const evidence = runtime.evidence;
      const port = recordingModelPort(
        runtime.port,
        (asked) => stores.asked.append(evidence.gameId, { ...asked, actionKey: null }),
        { gameId: evidence.gameId, actionKey: null },
      );
      const ask = (step: ReviewStep, sources: EvidenceSource[], task: unknown) =>
        judgeReview(port, runtime.access, step, sources, task, {
          taskId: config.executionInfo?.taskId,
          checkpointId: config.executionInfo?.checkpointId,
        });
      const target = evidence.targets[state.decisions.length];
      if (target) {
        const result = await ask('review_decision', target.sources, {
          actionKey: target.actionKey,
          actionType: target.actionType,
          actorId: target.actorId,
        });
        return { decisions: [...state.decisions, result] };
      }
      const player = evidence.players[state.players.length];
      if (player) {
        const sources = playerSources(state, evidence, player.id);
        const result = sources.length
          ? await ask('review_player', sources, {
              player,
              gaps: evidence.gaps.filter((gap) => gap.actorId === player.id),
            })
          : null;
        return {
          players: [
            ...state.players,
            {
              playerId: player.id,
              evaluatedDecisions: evidence.targets.filter((item) => item.actorId === player.id)
                .length,
              limitation: result ? null : '没有可评价的最终决定，无法形成玩家表现判断',
              result,
            },
          ],
        };
      }
      const outcome = await ask('review_outcome', evidence.omniscient, {
        gameId: evidence.gameId,
        gaps: evidence.gaps,
      });
      return { outcome, completedAt: new Date().toISOString() };
    })
    .addEdge(START, 'evaluate')
    .addConditionalEdges('evaluate', (state) => (state.completedAt ? END : 'evaluate'), [
      'evaluate',
      END,
    ])
    .compile({ checkpointer: stores.checkpoints });
}

/** 读取只检查原生图状态，不触发节点，也不需要模型凭据。 */
export async function readReview(stores: GameStores, gameId: string): Promise<ReviewReport | null> {
  const [archive, state] = await Promise.all([
    preparationGraph(stores).getState(configOf(gameId, true)),
    reviewGraph(stores).getState(configOf(gameId)),
  ]);
  const prepared = archive.values.prepared as PreparedReview | null | undefined;
  return prepared
    ? {
        ...prepared,
        decisions: [],
        players: [],
        outcome: null,
        completedAt: null,
        ...(state.values as Partial<typeof ReviewState.State>),
      }
    : null;
}

export async function runReview(
  stores: GameStores,
  gameId: string,
  runtime: { port: ModelPort; access: ModelAccess },
) {
  const graph = reviewGraph(stores);
  const saved = await readReview(stores, gameId);
  if (saved?.completedAt) return saved;
  const profile = judgeProfile(runtime.access);
  const archiveConfig = configOf(gameId, true);
  const prepared: PreparedReview =
    saved ??
    (
      await preparationGraph(stores).invoke(
        (await stores.checkpoints.getTuple(archiveConfig)) ? null : {},
        { ...archiveConfig, context: { gameId, judge: profile }, durability: 'sync' },
      )
    ).prepared!;
  if (!isDeepStrictEqual(prepared.judge, profile)) {
    throw new Error('复盘续跑必须使用原评审模型、端点及能力配置');
  }
  const evidence = prepared.evidence;
  const result = await graph.invoke(
    (await stores.checkpoints.getTuple(configOf(gameId))) ? null : {},
    {
      ...configOf(gameId),
      context: { ...runtime, evidence },
      durability: 'sync',
      recursionLimit: evidence.targets.length + evidence.players.length + 5,
    },
  );
  return { ...prepared, ...result };
}
