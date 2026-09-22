import { MemorySaver } from '@langchain/langgraph';
import type { StageAnchor } from '../core/loop';
import type { ActionIntent, ActionStore, StoredAction } from './actions';
import type { AskedPromptStore, StoredAskedPrompt } from './asked';
import type { EventStore, StoredEvent } from './events';
import type { GameStore, StoredGame } from './games';
import type { StepStore } from './steps';
import type { GameStores } from './stores';

/**
 * 整局跑在内存里的那几份存储：进程一结束就没了。
 * 落库那份的意义只在「断了再起」，一局跑完就结束的跑法不需要它。
 */
export function memoryStores(): GameStores {
  return {
    games: memoryGames(),
    events: memoryEvents(),
    actions: memoryActions(),
    steps: memorySteps(),
    asked: memoryAsked(),
    checkpoints: new MemorySaver(),
  };
}

export function memoryGames(): GameStore {
  const byId = new Map<string, StoredGame>();

  return {
    find: (gameId) => Promise.resolve(byId.get(gameId) ?? null),

    async open(game) {
      // 已经立过档的不再写，跟库里那条 update: {} 一个意思：先立那份留着。
      if (!byId.has(game.gameId)) byId.set(game.gameId, { ...game, winner: null });
    },

    async finish(gameId, winner) {
      const row = byId.get(gameId);
      if (!row) throw new Error(`没立过档就直接记胜方：${gameId}`);
      byId.set(gameId, { ...row, winner });
    },
  };
}

export function memoryEvents(): EventStore {
  const byGame = new Map<string, StoredEvent[]>();

  return {
    list: (gameId) => Promise.resolve([...(byGame.get(gameId) ?? [])]),

    async append(gameId, event) {
      const rows = byGame.get(gameId) ?? [];
      // 同一个键写第二遍是 bug，跟库里那条唯一键一个意思：当场抛，不静默少一条。
      if (rows.some((row) => row.eventKey === event.eventKey)) {
        throw new Error(`这一局的事件里已经有 ${event.eventKey}`);
      }

      rows.push(event);
      byGame.set(gameId, rows);
    },
  };
}

export function memoryActions(): ActionStore {
  const byKey = new Map<string, StoredAction>();

  return {
    find: (actionKey) => Promise.resolve(byKey.get(actionKey) ?? null),

    // Map 按立的先后排，跟库里按落库先后排一个意思。
    list: (gameId) => Promise.resolve([...byKey.values()].filter((row) => row.gameId === gameId)),

    async begin(intent: ActionIntent) {
      // 已经立过的不再写：重走同一问会把同一份意图再立一次，先立那份原样留着。
      if (!byKey.has(intent.actionKey)) {
        byKey.set(intent.actionKey, { ...intent, status: 'running', outcome: null });
      }
    },

    async finish(actionKey, outcome) {
      const row = byKey.get(actionKey);
      if (!row) throw new Error(`没立过意图就直接补结果：${actionKey}`);
      byKey.set(actionKey, { ...row, status: 'done', outcome });
    },
  };
}

export function memoryAsked(): AskedPromptStore {
  const byGame = new Map<string, StoredAskedPrompt[]>();

  return {
    async append(gameId, asked) {
      const rows = byGame.get(gameId) ?? [];
      // 同一问重问几遍就是几行：这里一次都不去重，跟库里那张表一个意思。
      rows.push(asked);
      byGame.set(gameId, rows);
    },
  };
}

export function memorySteps(): StepStore {
  const byGame = new Map<string, StageAnchor[]>();

  return {
    last: (gameId) => Promise.resolve(byGame.get(gameId)?.at(-1) ?? null),

    async append(gameId, anchor) {
      const rows = byGame.get(gameId) ?? [];
      // 同一格落第二遍不再写，跟库里那条主键一个意思：先落那份留着。
      if (!rows.some((row) => row.phaseInstanceId === anchor.phaseInstanceId)) rows.push(anchor);
      byGame.set(gameId, rows);
    },
  };
}
