import {
  END,
  START,
  StateGraph,
  StateSchema,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { GameStores } from '../store/stores';
import { REVIEW_VERSION, reviewId, type ReviewAnalysis, type ReviewUnit } from './contracts';
import { prepareEvidence, type ReviewEvidence } from './evidence';
import { nativeCost } from './cost';
import { reviewPlatform, type ReviewPlatform, type ReviewProfile } from './platform';

interface PreparedReview {
  evidence: ReviewEvidence;
  profile: ReviewProfile;
  version: string;
  startedAt: string;
}
type UnitIdentity = Omit<ReviewUnit, 'sources' | 'task'>;
interface Receipt extends UnitIdentity {
  scoreId: string;
  hash: string;
}
const PreparedState = new StateSchema({
  prepared: z.custom<PreparedReview | null>().default(null),
});
const PrepareContext = z.object({ gameId: z.string(), profile: z.custom<ReviewProfile>() });
const ReviewState = new StateSchema({
  receipts: z.array(z.custom<Receipt>()).default(() => []),
  pending: z.custom<ReviewUnit | null>().default(null),
  completedAt: z.string().nullable().default(null),
});
const Runtime = z.object({
  prepared: z.custom<PreparedReview>(),
  platform: z.custom<ReviewPlatform>(),
});
type ReviewConfig = LangGraphRunnableConfig<z.infer<typeof Runtime>>;

function configOf(gameId: string, archive = false) {
  return {
    configurable: {
      thread_id: JSON.stringify([gameId, 'review', REVIEW_VERSION, archive ? 'evidence' : 'run']),
    },
  };
}

function preparationGraph(stores: GameStores) {
  return new StateGraph(PreparedState, { context: PrepareContext })
    .addNode(
      'prepare',
      async (_state, config: LangGraphRunnableConfig<z.infer<typeof PrepareContext>>) => ({
        prepared: {
          evidence: await prepareEvidence(stores, config.context!.gameId),
          profile: config.context!.profile,
          version: REVIEW_VERSION,
          startedAt: new Date().toISOString(),
        },
      }),
    )
    .addEdge(START, 'prepare')
    .addEdge('prepare', END)
    .compile({ checkpointer: stores.checkpoints });
}

function specsOf(evidence: ReviewEvidence): Pick<ReviewUnit, 'key' | 'step'>[] {
  return [
    ...evidence.targets.map((target) => ({
      key: `decision/${target.actionKey}`,
      step: 'review_decision' as const,
    })),
    ...evidence.players
      .filter((player) => evidence.targets.some((item) => item.actorId === player.id))
      .map((player) => ({ key: `player/${player.id}`, step: 'review_player' as const })),
    { key: 'outcome', step: 'review_outcome' },
  ];
}

/** 已提交输入由冻结证据及平台已接受正文还原，不在每轮检查点累积整局题面。 */
function unitOf(
  identity: UnitIdentity,
  evidence: ReviewEvidence,
  decisions = new Map<string, ReviewAnalysis>(),
): ReviewUnit {
  const { key, step, traceId, spanId, createdAt } = identity;
  const base = { key, step, traceId, spanId, createdAt };
  if (identity.step === 'review_decision') {
    const target = evidence.targets.find((item) => identity.key === `decision/${item.actionKey}`)!;
    return {
      ...base,
      sources: target.sources,
      task: { actionKey: target.actionKey, actionType: target.actionType, actorId: target.actorId },
    };
  }
  if (identity.step === 'review_player') {
    const player = evidence.players.find((item) => identity.key === `player/${item.id}`)!;
    const sources = evidence.targets
      .filter((item) => item.actorId === player.id)
      .map((item) => ({
        id: `${evidence.gameId}/assessment/${encodeURIComponent(item.actionKey)}`,
        origin: { actionKey: item.actionKey, path: 'review' },
        value: decisions.get(`decision/${item.actionKey}`)!,
      }));
    return {
      ...base,
      sources,
      task: { player, gaps: evidence.gaps.filter((gap) => gap.actorId === player.id) },
    };
  }
  return {
    ...base,
    sources: evidence.omniscient,
    task: { gameId: evidence.gameId, gaps: evidence.gaps },
  };
}

async function accepted(
  unit: ReviewUnit,
  receipt: Receipt,
  profile: ReviewProfile,
  platform: ReviewPlatform,
) {
  const result = await platform.result(unit, profile);
  if (
    !result ||
    receipt.scoreId !== result.scoreId ||
    receipt.hash !== reviewId(JSON.stringify(result))
  ) {
    throw new Error('已接受的 Langfuse 复盘被删除或改写，不能混合新旧评价');
  }
  return result;
}

async function decisionResults(
  receipts: Receipt[],
  prepared: PreparedReview,
  platform: ReviewPlatform,
) {
  return new Map(
    await Promise.all(
      receipts
        .filter((item) => item.step === 'review_decision')
        .map(
          async (item) =>
            [
              item.key,
              await accepted(unitOf(item, prepared.evidence), item, prepared.profile, platform),
            ] as const,
        ),
    ),
  );
}

/** 平台负责模型与结果；这里只保存提交凭据并编排有依赖的输入。 */
function reviewGraph(stores: GameStores) {
  const newClaims = new Set<string>();
  return new StateGraph(ReviewState, { context: Runtime })
    .addNode('claim', async (state, config: ReviewConfig) => {
      const { prepared, platform } = config.context!;
      const spec = specsOf(prepared.evidence)[state.receipts.length];
      if (!spec) return { completedAt: new Date().toISOString() };
      const decisions =
        spec.step === 'review_player'
          ? await decisionResults(
              state.receipts.filter((receipt) =>
                prepared.evidence.targets.some(
                  (target) =>
                    receipt.key === `decision/${target.actionKey}` &&
                    spec.key === `player/${target.actorId}`,
                ),
              ),
              prepared,
              platform,
            )
          : undefined;
      const pending = unitOf(
        {
          ...spec,
          createdAt: new Date().toISOString(),
          traceId: reviewId(
            JSON.stringify([
              prepared.evidence.gameId,
              REVIEW_VERSION,
              prepared.profile.fingerprint,
              spec.key,
            ]),
          ),
          spanId: reviewId(spec.key).slice(0, 16),
        },
        prepared.evidence,
        decisions,
      );
      newClaims.add(pending.key);
      return { pending };
    })
    .addNode('submit', async (state, config: ReviewConfig) => {
      const unit = state.pending!;
      const platform = config.context!.platform;
      if (newClaims.delete(unit.key)) await platform.submit(unit);
      // 恢复到已有凭据时，读不到不等于没提交，不能盲目重投。
      else if (!(await platform.exists(unit)))
        throw new Error('复盘提交状态未知；请核查 Langfuse 接收记录，续跑不会重复投递');
      return {};
    })
    .addNode('collect', async (state, config: ReviewConfig) => {
      const { prepared, platform } = config.context!;
      const unit = state.pending!;
      const result = await platform.wait(unit, prepared.profile);
      if (!isDeepStrictEqual(prepared.profile, await platform.profile()))
        throw new Error('Langfuse 评价配置已改变，不能混合版本续跑');
      const { key, step, traceId, spanId, createdAt } = unit;
      return {
        pending: null,
        receipts: [
          ...state.receipts,
          {
            key,
            step,
            traceId,
            spanId,
            createdAt,
            scoreId: result.scoreId,
            hash: reviewId(JSON.stringify(result)),
          },
        ],
      };
    })
    .addEdge(START, 'claim')
    .addConditionalEdges('claim', (state) => (state.completedAt ? END : 'submit'), ['submit', END])
    .addEdge('submit', 'collect')
    .addEdge('collect', 'claim')
    .compile({ checkpointer: stores.checkpoints });
}

/** 本地关联状态读取不访问平台，也不触发执行。 */
export async function readReviewState(stores: GameStores, gameId: string) {
  const [archive, state] = await Promise.all([
    preparationGraph(stores).getState(configOf(gameId, true)),
    reviewGraph(stores).getState(configOf(gameId)),
  ]);
  const prepared = archive.values.prepared as PreparedReview | null | undefined;
  return prepared
    ? {
        ...prepared,
        receipts: [] as Receipt[],
        pending: null as ReviewUnit | null,
        completedAt: null as string | null,
        ...(state.values as Partial<typeof ReviewState.State>),
      }
    : null;
}

/** 正文与开销只从平台读取，不调用模型、不补投任务。 */
export async function readReview(stores: GameStores, gameId: string, platform?: ReviewPlatform) {
  const saved = await readReviewState(stores, gameId);
  if (!saved) return null;
  const source = platform ?? reviewPlatform();
  const decisions = await decisionResults(saved.receipts, saved, source);
  const entries = [
    ...saved.receipts.map((receipt) => ({
      unit: unitOf(receipt, saved.evidence, decisions),
      receipt,
    })),
    ...(saved.pending ? [{ unit: saved.pending, receipt: null }] : []),
  ];
  const units = await Promise.all(
    entries.map(async ({ unit, receipt }) => ({
      ...unit,
      result: receipt
        ? (decisions.get(unit.key) ?? (await accepted(unit, receipt, saved.profile, source)))
        : null,
      cost: nativeCost(await source.generations(unit, saved.profile)),
    })),
  );
  return {
    evidence: saved.evidence,
    profile: saved.profile,
    version: saved.version,
    startedAt: saved.startedAt,
    completedAt: saved.completedAt,
    units,
    players: saved.evidence.players.map((player) => ({
      playerId: player.id,
      evaluatedDecisions: saved.evidence.targets.filter(
        (item) => item.actorId === player.id && decisions.has(`decision/${item.actionKey}`),
      ).length,
      result: units.find((unit) => unit.key === `player/${player.id}`)?.result ?? null,
      limitation: saved.evidence.targets.some((item) => item.actorId === player.id)
        ? null
        : '没有可评价的最终决定，无法形成玩家表现判断',
    })),
    outcome: units.find((unit) => unit.step === 'review_outcome')?.result ?? null,
  };
}

export async function runReview(
  stores: GameStores,
  gameId: string,
  platform: ReviewPlatform = reviewPlatform(),
) {
  const saved = await readReviewState(stores, gameId);
  if (saved?.completedAt) return readReview(stores, gameId, platform);
  const profile = await platform.profile();
  const archiveConfig = configOf(gameId, true);
  const prepared: PreparedReview =
    saved ??
    (
      await preparationGraph(stores).invoke(
        (await stores.checkpoints.getTuple(archiveConfig)) ? null : {},
        { ...archiveConfig, context: { gameId, profile }, durability: 'sync' },
      )
    ).prepared!;
  if (!isDeepStrictEqual(prepared.profile, profile))
    throw new Error('Langfuse 评价配置已改变，不能混合版本续跑');
  await reviewGraph(stores).invoke(
    (await stores.checkpoints.getTuple(configOf(gameId))) ? null : {},
    {
      ...configOf(gameId),
      context: { prepared, platform },
      durability: 'sync',
      recursionLimit: specsOf(prepared.evidence).length * 3 + 2,
    },
  );
  return readReview(stores, gameId, platform);
}
