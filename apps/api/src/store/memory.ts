import { MemorySaver } from '@langchain/langgraph';
import { GAME_STATUSES, type AgentMemories } from '@werewolf/shared';
import { randomUUID } from 'node:crypto';
import type { StageAnchor } from '../core/loop';
import {
  ActionSnapshotFields,
  type ActionIntent,
  type ActionStore,
  type StoredAction,
} from './actions';
import { DuplicateAgentNameError, type AgentStore, type StoredAgent } from './agents';
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
    agents: memoryAgents(),
    events: memoryEvents(),
    actions: memoryActions(),
    steps: memorySteps(),
    asked: memoryAsked(),
    checkpoints: new MemorySaver(),
  };
}

export function memoryAgents(): AgentStore {
  const byId = new Map<string, StoredAgent>();
  const memoriesByAgent = new Map<string, AgentMemories>();

  const require = (id: string): StoredAgent => {
    const row = byId.get(id);
    if (!row) throw new Error(`没这个 agent：${id}`);
    return row;
  };

  return {
    // Map 按建的先后排，倒过来就是新建的在前，跟库里按 createdAt 倒序一个意思。
    list: (includeInactive) =>
      Promise.resolve(
        [...byId.values()].filter((row) => includeInactive || row.isActive).toReversed(),
      ),

    find: (id) => Promise.resolve(byId.get(id) ?? null),

    findByName: (name) =>
      Promise.resolve([...byId.values()].find((row) => row.name === name) ?? null),

    findMany: (ids) => Promise.resolve(ids.flatMap((id) => byId.get(id) ?? [])),

    async create(input) {
      // 重名写第二遍是调用方的事，跟库里那条唯一键一个意思：当场抛，不静默多一个同名的。
      if ([...byId.values()].some((row) => row.name === input.name)) {
        throw new DuplicateAgentNameError(input.name);
      }

      const row: StoredAgent = { id: randomUUID(), isActive: true, ...input };
      byId.set(row.id, row);
      return row;
    },

    async update(id, patch) {
      const row = { ...require(id), ...patch };
      byId.set(id, row);
      return row;
    },

    memories: (agentId) =>
      Promise.resolve(memoriesByAgent.get(agentId) ?? { persona: [], strategy: [] }),

    // 要过的 id 一个不落，与库里那条一个意思。
    memoriesMany: (ids) =>
      Promise.resolve(
        new Map(
          ids.map((id) => [id, memoriesByAgent.get(id) ?? { persona: [], strategy: [] }] as const),
        ),
      ),

    // 交上来的就是全集，跟库里那个先清后写的事务一个意思。
    replaceMemories: (agentId, memories) => {
      memoriesByAgent.set(agentId, memories);
      return Promise.resolve();
    },
  };
}

export function memoryGames(): GameStore {
  const byId = new Map<string, StoredGame>();

  return {
    find: (gameId) => Promise.resolve(byId.get(gameId) ?? null),

    async open(game) {
      // 已经立过档的不再写，跟库里那条 update: {} 一个意思：先立那份留着。
      if (!byId.has(game.gameId)) {
        byId.set(game.gameId, {
          ...game,
          winner: null,
          finalState: null,
          status: GAME_STATUSES.QUEUED,
          createdAt: new Date(),
        });
      }
    },

    async finish(gameId, winner, finalState) {
      const row = byId.get(gameId);
      if (!row) throw new Error(`没立过档就直接记胜方：${gameId}`);
      byId.set(gameId, { ...row, winner, finalState, status: GAME_STATUSES.FINISHED });
    },

    async setStatus(gameId, status) {
      const row = byId.get(gameId);
      if (!row) throw new Error(`没立过档就直接改状态：${gameId}`);
      byId.set(gameId, { ...row, status });
    },

    // Map 按立的先后排，倒过来就是新开的在前，跟库里按 createdAt 倒序一个意思。
    list: () => Promise.resolve([...byId.values()].toReversed()),
  };
}

export function memoryEvents(): EventStore {
  const byGame = new Map<string, StoredEvent[]>();

  return {
    list: (gameId, after = 0) =>
      Promise.resolve((byGame.get(gameId) ?? []).filter((row) => row.seq > after)),
    positions: (gameId) =>
      Promise.resolve((byGame.get(gameId) ?? []).map(({ eventKey, seq }) => ({ eventKey, seq }))),

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

    async summaries(gameId) {
      return [...byKey.values()]
        .filter((row) => row.gameId === gameId)
        .map((row) => {
          if (row.status === 'running') return { ...row, outcome: null, hasReasoning: false };
          const { reasoning, ...snapshot } = ActionSnapshotFields.parse(
            (row.outcome as { snapshot: unknown }).snapshot,
          );
          return { ...row, outcome: { snapshot }, hasReasoning: Boolean(reasoning) };
        });
    },

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

    latest: (gameIds) =>
      Promise.resolve(
        new Map(
          gameIds.flatMap((gameId) => {
            const anchor = byGame.get(gameId)?.at(-1);

            return anchor ? [[gameId, anchor] as const] : [];
          }),
        ),
      ),

    async append(gameId, anchor) {
      const rows = byGame.get(gameId) ?? [];
      // 同一格落第二遍不再写，跟库里那条主键一个意思：先落那份留着。
      if (!rows.some((row) => row.phaseInstanceId === anchor.phaseInstanceId)) rows.push(anchor);
      byGame.set(gameId, rows);
    },
  };
}
