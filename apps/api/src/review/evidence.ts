import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ACTION_TYPES,
  GAME_STATUSES,
  PreviousJudgmentSchema,
  ExperienceSnapshotSchema,
  KnowledgeSnapshotSchema,
} from '@werewolf/shared';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { GameStores } from '../store/stores';

const SnapshotSchema = z.object({
  actionKey: z.string(),
  actionType: z.string(),
  actorId: z.string(),
  sourceCallId: z.string().min(1),
  decision: z.unknown(),
  schema: z.record(z.string(), z.unknown()).nullable().optional(),
  reasoning: z.string().nullable(),
  context: z.object({
    task: z.string(),
    day: z.number(),
    actor: z.object({ playerId: z.string(), seatNo: z.number(), role: z.string() }),
    visible: z.array(z.object({ title: z.string(), lines: z.array(z.string()) })),
    previousJudgment: PreviousJudgmentSchema.optional(),
    experiences: z.array(ExperienceSnapshotSchema).optional(),
    knowledge: z.array(KnowledgeSnapshotSchema).optional(),
    options: z.array(z.string()),
    skill: z.array(z.string()),
  }),
});
const OutcomeSchema = z.object({ decision: z.unknown(), snapshot: SnapshotSchema });

export interface EvidenceSource {
  id: string;
  /** 快照用路径定位；事件用 seq 定位，不靠文本相似度拼接。 */
  origin: { actionKey: string; path: string } | { seq: number } | { path: string };
  value: unknown;
}
export interface ReviewTarget {
  actionKey: string;
  actorId: string;
  actionType: string;
  sourceCallId: string;
  sources: EvidenceSource[];
}
export interface EvidenceGap {
  actorId: string;
  actionKey: string;
  reason: string;
}
export interface ReviewEvidence {
  /** 冻结输入的装配格式；未标版本的既有报告保持原来源映射。 */
  formatVersion?: 2;
  gameId: string;
  players: { id: string; seatNo: number }[];
  targets: ReviewTarget[];
  gaps: EvidenceGap[];
  omniscient: EvidenceSource[];
}

export async function finishedGame(stores: GameStores, gameId: string) {
  const game = await stores.games.find(gameId);
  if (!game) throw new NotFoundException(`没有这一局：${gameId}`);
  if (game.status !== GAME_STATUSES.FINISHED || !game.winner || !game.finalState) {
    throw new BadRequestException('只有已结束且保存终局的对局可以复盘');
  }
  return game;
}

export async function prepareEvidence(stores: GameStores, gameId: string): Promise<ReviewEvidence> {
  const game = await finishedGame(stores, gameId);
  const [actions, events] = await Promise.all([
    stores.actions.list(gameId),
    stores.events.list(gameId),
  ]);
  const players = game.finalState!.players.map(({ id, seatNo }) => ({ id, seatNo }));
  const published = new Map(events.map((event) => [event.eventKey, event]));
  const targets: ReviewTarget[] = [];
  const gaps: EvidenceGap[] = [];
  const boardRules = new Set<string>();
  for (const action of actions) {
    // 日终记录用于认知延续，不作为额外的自动评价任务。
    if (action.actionType === ACTION_TYPES.DAY_END_JUDGMENT) continue;
    const gap = (reason: string) =>
      gaps.push({ actorId: action.actorId, actionKey: action.actionKey, reason });
    if (action.status !== 'done') {
      gap('行动没有最终结果，可能被取消或中断；不据此评价玩家表现');
      continue;
    }
    const parsed = OutcomeSchema.safeParse(action.outcome);
    if (!parsed.success) {
      gap('缺少完整决定快照或最终调用来源');
      continue;
    }
    const { snapshot, decision } = parsed.data;
    if (
      snapshot.actionKey !== action.actionKey ||
      snapshot.actorId !== action.actorId ||
      snapshot.actionType !== action.actionType ||
      snapshot.context.actor.playerId !== action.actorId ||
      !players.some((p) => p.id === action.actorId && p.seatNo === snapshot.context.actor.seatNo) ||
      !isDeepStrictEqual(snapshot.decision, decision)
    ) {
      gap('决定与快照身份或结果不一致');
      continue;
    }
    const speech = published.get(action.actionKey);
    if (
      action.actionType === ACTION_TYPES.SPEECH &&
      (!speech || !['public_speech', 'wolf_speech'].includes(speech.kind))
    ) {
      gap('发言没有对应的正式发布事件');
      continue;
    }
    const sources: EvidenceSource[] = [];
    const add = (path: string, value: unknown) =>
      sources.push({
        id: `${gameId}/action/${encodeURIComponent(action.actionKey)}/${path}`,
        origin: { actionKey: action.actionKey, path },
        value,
      });
    add('context/task', snapshot.context.task);
    add('context/actor', snapshot.context.actor);
    add('context/day', snapshot.context.day);
    if (snapshot.context.knowledge?.length)
      add('context/knowledge', {
        meaning: '外部攻略参考，不是本局事实；输入不代表明确采纳',
        items: snapshot.context.knowledge,
      });
    if (snapshot.context.experiences?.length)
      add('context/experiences', {
        meaning: '历史经验参考，不是本局事实；输入不代表明确采纳',
        items: snapshot.context.experiences,
      });
    if (snapshot.context.previousJudgment) {
      add('context/previousJudgment', {
        meaning: '本人此前的主观判断，不是已确认事实，可以被当前证据推翻',
        ...snapshot.context.previousJudgment,
      });
    }
    snapshot.context.visible.forEach((block, i) =>
      block.lines.forEach((line, j) =>
        add(`context/visible/${i}/lines/${j}`, { title: block.title, line }),
      ),
    );
    snapshot.context.options.forEach((option, i) => add(`context/options/${i}`, option));
    snapshot.context.skill.forEach((skill, i) => add(`context/skill/${i}`, skill));
    add('decision', decision);
    add('reasoning', snapshot.reasoning);
    if (snapshot.schema !== undefined) add('schema', snapshot.schema);
    if (action.actionType === ACTION_TYPES.SPEECH) {
      sources.push({
        id: `${gameId}/event/${speech!.seq}`,
        origin: { seq: speech!.seq },
        value: speech!.text,
      });
    }
    targets.push({
      actionKey: action.actionKey,
      actorId: action.actorId,
      actionType: action.actionType,
      sourceCallId: snapshot.sourceCallId,
      sources,
    });
    const rules = snapshot.context.skill[0];
    if (rules) boardRules.add(rules);
  }
  return {
    formatVersion: 2,
    gameId,
    players,
    targets,
    gaps,
    omniscient: [
      { id: `${gameId}/result`, origin: { path: 'game/winner' }, value: game.winner },
      { id: `${gameId}/final`, origin: { path: 'game/finalState' }, value: game.finalState },
      ...events.map((event) => ({
        id: `${gameId}/event/${event.seq}`,
        origin: { seq: event.seq },
        value: { day: event.day, kind: event.kind, text: event.text, audience: event.audience },
      })),
      ...targets.map((target) => ({
        id: `${gameId}/proposal/${encodeURIComponent(target.actionKey)}`,
        origin: { actionKey: target.actionKey, path: 'decision' },
        value: {
          actorId: target.actorId,
          actionType: target.actionType,
          decision: target.sources.find(
            (source) => 'path' in source.origin && source.origin.path === 'decision',
          )!.value,
          meaning: '最终回答，不代表规则实际执行了该提议',
        },
      })),
      ...[...boardRules].map((value, index) => ({
        id: `${gameId}/rules/${index}`,
        origin: { path: 'boardRules' },
        value,
      })),
    ],
  };
}

export function reviewPreview(evidence: ReviewEvidence) {
  const playerCalls = evidence.players.filter((player) =>
    evidence.targets.some((t) => t.actorId === player.id),
  ).length;
  return {
    decisions: evidence.targets.length,
    players: evidence.players.length,
    gaps: evidence.gaps,
    expectedLogicalCalls: evidence.targets.length + playerCalls + 1,
    evidenceCharacters: {
      decisions: evidence.targets.reduce((sum, target) => sum + JSON.stringify(target).length, 0),
      omniscient: JSON.stringify(evidence.omniscient).length,
    },
    note: '字符量不等于 token 或费用；不含提示词、逐玩家汇总输入和重试。缺少决定的玩家只列证据不足，不调用模型。',
  };
}
