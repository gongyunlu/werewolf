import { ACTION_TYPES } from '@werewolf/shared';
import type { GameState } from '../core/state';
import { phaseInstanceId } from '../core/identity';
import { memoryStores } from '../store/memory';
import type { ActionIntent } from '../store/actions';

export async function reviewFixture(gameId = 'g') {
  const stores = memoryStores();
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
    actionKey: 'a',
    phaseInstanceId: '1/day',
    actorId: 'p1',
    actionType: ACTION_TYPES.VOTE,
    actionOrdinal: 0,
    ledgerSeq: 1,
  };
  await stores.actions.begin(action);
  await stores.actions.finish('a', {
    decision: 2,
    snapshot: {
      actionKey: 'a',
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
