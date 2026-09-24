import type { ActionProvider } from '../actions';
import { seatNames, type FlowObserver } from '../flow';
import type { GameState } from '../state';
import type { BallotObserver } from '../vote';
import { checkWin } from '../win';
import { announceDay, type NightDeath } from './announce';
import { runSheriffElection } from './election';

export interface DawnInput {
  state: GameState;
  deaths: readonly NightDeath[];
  actions: ActionProvider;
  minute: number;
  observe?: (state: GameState) => void;
  onBallot?: BallotObserver;
  onFlow?: FlowObserver;
}

/** 先完成竞选或续选，再公布夜间死讯；警上即时出局的人不再重复公布。 */
export async function runDawn(input: DawnInput) {
  const { state, actions, minute, observe, onBallot, onFlow } = input;
  const dayFlow: FlowObserver = async (current, event) => {
    await onFlow?.(current, { ...event, phase: 'day' });
  };
  await dayFlow(state, { key: 'daybreak', text: '天亮了。' });
  const election = await runSheriffElection(
    state,
    actions,
    minute,
    observe,
    onBallot,
    dayFlow,
    input.deaths,
  );
  observe?.(election.state);
  if (state.hasSheriff && !state.sheriffElectionSettled) {
    await dayFlow(election.state, {
      key: 'election-result',
      kind: 'sheriff',
      text: election.state.sheriffId
        ? `${seatNames(election.state, [election.state.sheriffId])} 当选警长。`
        : election.state.sheriffElectionSuspended
          ? '警长竞选被打断，下一天继续。'
          : '警长竞选结束，本局没有警长。',
    });
  }
  if (election.aborted && checkWin(election.state) !== null) {
    return { state: election.state, deaths: [], aborted: true };
  }

  const aliveIds = new Set(
    election.state.players.filter((player) => player.isAlive).map((player) => player.id),
  );
  const deaths = input.deaths.filter((death) => aliveIds.has(death.playerId));
  const announced = announceDay(election.state, deaths);
  observe?.(announced.state);
  await dayFlow(announced.state, {
    key: 'dawn',
    text: deaths.length
      ? `昨晚 ${seatNames(
          announced.state,
          announced.deaths.map((death) => death.playerId),
        )} 倒牌。`
      : input.deaths.length
        ? '昨晚没有其他玩家倒牌。'
        : '昨晚是平安夜。',
  });
  return { state: announced.state, deaths, aborted: election.aborted };
}
