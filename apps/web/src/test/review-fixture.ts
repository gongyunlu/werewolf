import type { GameDetail, ReviewPreview, ReviewReport, ReviewResponse } from '@werewolf/shared';

export const reviewGame: GameDetail = {
  gameId: 'g-review',
  boardId: '6p_white_wolf',
  status: 'finished',
  winner: 'good',
  createdAt: '2026-09-25T12:00:00.000Z',
  aliveCount: 1,
  day: 2,
  roster: [],
  players: [
    {
      id: 'p1',
      seatNo: 1,
      role: 'seer',
      faction: 'good',
      isAlive: true,
      deathDay: null,
      deathCause: null,
      isSheriff: false,
    },
    {
      id: 'p2',
      seatNo: 2,
      role: 'villager',
      faction: 'good',
      isAlive: false,
      deathDay: 1,
      deathCause: 'night_kill',
      isSheriff: false,
    },
  ],
};

export function reviewReport(): ReviewReport {
  const sources = [
    {
      id: 'g-review/action/a1/context/day',
      origin: { actionKey: 'a1', path: 'context/day' },
      value: 1,
    },
    {
      id: 'g-review/action/a1/reasoning',
      origin: { actionKey: 'a1', path: 'reasoning' },
      value: '这是当时记录的原始理由。',
    },
  ];
  return {
    evidence: {
      gameId: 'g-review',
      players: [
        { id: 'p1', seatNo: 1 },
        { id: 'p2', seatNo: 2 },
      ],
      targets: [{ actionKey: 'a1', actorId: 'p1', actionType: 'vote', sources }],
      gaps: [{ actorId: 'p2', actionKey: 'a2', reason: '行动没有最终结果，不据此判断表现' }],
    },
    version: 'langfuse-review-v1',
    startedAt: '2026-09-25T12:00:00.000Z',
    completedAt: '2026-09-25T12:05:00.000Z',
    units: [
      {
        key: 'decision/a1',
        step: 'review_decision',
        sources,
        result: {
          text: '决策分析只使用当时的理由 [E2]。',
          references: [{ label: 'E2', sourceId: sources[1].id }],
        },
      },
      {
        key: 'player/p1',
        step: 'review_player',
        sources: [
          {
            id: 'g-review/assessment/a1',
            origin: { actionKey: 'a1', path: 'review' },
            value: { text: '旧版保存的局部分析' },
          },
        ],
        result: {
          text: '玩家汇总 [D1]。',
          references: [{ label: 'D1', sourceId: 'g-review/assessment/a1' }],
        },
      },
      {
        key: 'outcome',
        step: 'review_outcome',
        sources: [
          {
            id: 'g-review/event/9',
            origin: { seq: 9 },
            value: { day: 2, text: '法官宣布好人胜利', audience: ['p1', 'p2'] },
          },
        ],
        result: {
          text: '全局终局分析 [O1]。',
          references: [{ label: 'O1', sourceId: 'g-review/event/9' }],
        },
      },
    ],
    players: [
      {
        playerId: 'p1',
        evaluatedDecisions: 1,
        result: {
          text: '玩家汇总 [D1]。',
          references: [{ label: 'D1', sourceId: 'g-review/assessment/a1' }],
        },
        limitation: null,
      },
      {
        playerId: 'p2',
        evaluatedDecisions: 0,
        result: null,
        limitation: '没有可分析的最终决定，证据不足',
      },
    ],
    outcome: {
      text: '全局终局分析 [O1]。',
      references: [{ label: 'O1', sourceId: 'g-review/event/9' }],
    },
  };
}

export const reviewPreview: ReviewPreview = {
  decisions: 1,
  players: 2,
  gaps: reviewReport().evidence.gaps,
  expectedLogicalCalls: 3,
  evidenceCharacters: { decisions: 100, omniscient: 80 },
  note: '字符量不等于 token 或费用。',
};

export function reviewResponse(status = 'completed'): ReviewResponse {
  const report = reviewReport();
  if (status !== 'completed') {
    report.completedAt = null;
    report.units = report.units
      .slice(0, 2)
      .map((unit) => (unit.step === 'review_player' ? { ...unit, result: null } : unit));
    report.players[0].result = null;
    report.outcome = null;
  }
  return {
    status,
    report: status === 'not_started' ? null : report,
    failure: status === 'failed' ? '复盘任务失败，已保存的结果可续跑' : null,
  };
}
