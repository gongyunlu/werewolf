import { ACTION_TYPES } from '@werewolf/shared';
import type { GameState } from '../core/state';
import { phaseInstanceId } from '../core/identity';
import { memoryStores } from '../store/memory';
import type { ActionIntent } from '../store/actions';
import type { GameStores } from '../store/stores';
import { analysisOf, unitInput, type ReviewAnalysis, type ReviewUnit } from './contracts';
import type { ReviewPlatform, ReviewProfile } from './platform';

export async function reviewFixture(
  gameId = 'g',
  stores: GameStores = memoryStores(),
  actionKey = 'a',
) {
  const state: GameState = {
    gameId,
    phaseInstanceId: phaseInstanceId(1, 'day'),
    day: 2,
    hasSheriff: false,
    sheriffId: null,
    sheriffElectionSuspended: null,
    sheriffElectionCandidateIds: null,
    sheriffElectionSettled: false,
    players: ['p1', 'p2'].map((id, index) => ({
      id,
      seatNo: index + 1,
      role: 'villager',
      faction: 'good',
      isAlive: true,
      deathDay: null,
      deathCause: null,
      hasAntidoteUsed: false,
      hasPoisonUsed: false,
      guardedOn: null,
      checkedIds: [],
    })),
  };
  await stores.games.open({ gameId, boardId: 'test', roster: [] });
  await stores.games.finish(gameId, 'good', state);
  const action: ActionIntent = {
    gameId,
    actionKey,
    phaseInstanceId: '1/day',
    actorId: 'p1',
    actionType: ACTION_TYPES.VOTE,
    actionOrdinal: 0,
    ledgerSeq: 1,
  };
  await stores.actions.begin(action);
  await stores.actions.finish(actionKey, {
    decision: 2,
    snapshot: {
      actionKey,
      actionType: ACTION_TYPES.VOTE,
      actorId: 'p1',
      sourceCallId: 'original-call',
      decision: 2,
      reasoning: null,
      context: {
        task: '投票',
        actor: { playerId: 'p1', seatNo: 1, role: '村民' },
        day: 1,
        visible: [{ title: '公开发言摘要', lines: ['当时的摘要'] }],
        options: ['2 号'],
        skill: ['村民找狼', '人设策略'],
      },
      critique: { accept: true, issues: '质疑者私有评价' },
    },
  });
  await stores.events.append(gameId, {
    seq: 1,
    eventKey: 'original',
    day: 1,
    text: '未看过的原文',
    kind: 'public_speech',
    audience: ['p1'],
  });
  return { stores, state, action };
}

export function fakeReviewPlatform() {
  const inputs = new Map<string, ReviewUnit>();
  const profile: ReviewProfile = {
    evaluatorId: 'e',
    evaluatorVersion: 1,
    ruleId: 'r',
    fingerprint: 'f',
  };
  const platform = {
    profile: jest.fn(async () => profile),
    exists: jest.fn(async (unit: ReviewUnit) => inputs.has(unit.key)),
    submit: jest.fn(async (unit: ReviewUnit) => {
      inputs.set(unit.key, structuredClone(unit));
    }),
    result: jest.fn(async (unit: ReviewUnit) => {
      if (!inputs.has(unit.key)) return null;
      return analysisOf(
        unit,
        `基于当时证据的判断 [证据:${unitInput(unit).sources[0]!.id}]`,
        `score/${unit.key}`,
        `trace/${unit.key}`,
      );
    }),
    wait: jest.fn(
      async (unit: ReviewUnit): Promise<ReviewAnalysis> => (await platform.result(unit))!,
    ),
    generations: jest.fn(async () => []),
  } satisfies ReviewPlatform;
  return { platform, inputs, profile };
}
