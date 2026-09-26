import { PrismaPg } from '@prisma/adapter-pg';
import {
  AGENT_MEMORY_TYPES,
  GAME_STATUSES,
  type ActionType,
  type AgentMemories,
  type AgentMemoryType,
  type GameStatus,
  ExperienceSnapshotSchema,
} from '@werewolf/shared';
import { parsePhaseInstanceId, type PhaseInstanceId } from '../core/identity';
import type { StageAnchor } from '../core/loop';
import type { GameState } from '../core/state';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import type { ActionStore, StoredAction, StoredActionSummary } from './actions';
import { DuplicateAgentNameError, type AgentStore, type StoredAgent } from './agents';
import type { AskedPromptStore } from './asked';
import { prismaCheckpoints } from './checkpoints';
import { EVENT_KINDS, type EventKind, type EventStore } from './events';
import type { GameStore, RosterSeat, StoredGame } from './games';
import type { StepStore } from './steps';
import type { GameStores } from './stores';
import { prismaObservations } from './prisma-observations';
import { prismaExperiences } from './prisma-experiences';

/** 连上对局库。调用方用完自己关。 */
export function openPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export function prismaStores(client: PrismaClient): GameStores {
  return {
    games: prismaGames(client),
    agents: prismaAgents(client),
    experiences: prismaExperiences(client),
    events: prismaEvents(client),
    actions: prismaActions(client),
    steps: prismaSteps(client),
    asked: prismaAsked(client),
    observations: prismaObservations(client),
    checkpoints: prismaCheckpoints(client),
  };
}

/** 对局档案的真身。 */
export function prismaGames(client: PrismaClient): GameStore {
  return {
    async find(gameId) {
      const row = await client.game.findUnique({ where: { id: gameId } });
      return row ? storedGame(row) : null;
    },

    async open(game) {
      await client.game.upsert({
        where: { id: game.gameId },
        create: {
          id: game.gameId,
          boardId: game.boardId,
          roster: game.roster as unknown as Prisma.InputJsonValue,
        },
        // 已经立过档的留着：它记的是开局那一刻，重开一次不该把它换掉。
        // 顺带也不改状态：接着跑一局没跑完的，它排到哪儿就是哪儿。
        update: {},
      });
    },

    async finish(gameId, winner, state) {
      await client.game.update({
        where: { id: gameId },
        data: {
          winner,
          finalState: state as unknown as Prisma.InputJsonValue,
          status: GAME_STATUSES.FINISHED,
        },
      });
    },

    async setStatus(gameId, status) {
      await client.game.update({ where: { id: gameId }, data: { status } });
    },

    async list() {
      const rows = await client.game.findMany({ orderBy: { createdAt: 'desc' } });
      return rows.map(storedGame);
    },
  };
}

/** 一行档案摊成存储那一头的样子：认一行与列一页用的是同一种行，摊法只此一份。 */
function storedGame(row: Prisma.GameModel): StoredGame {
  return {
    gameId: row.id,
    boardId: row.boardId,
    // 阵容这一列是自己写进去的，读回来按原样算；没写过（老行、命令行开的局）算空。
    roster: (row.roster ?? []) as unknown as RosterSeat[],
    winner: row.winner,
    finalState: row.finalState as unknown as GameState | null,
    status: gameStatusOf(row.status),
    createdAt: row.createdAt,
  };
}

/** agent 档案的真身。名字是对局里认人的那一个，重名最后由库的唯一键挡住，不在这儿先查一遍。 */
export function prismaAgents(client: PrismaClient): AgentStore {
  return {
    async list(includeInactive) {
      const rows = await client.agent.findMany({
        where: includeInactive ? {} : { isActive: true },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(storedAgent);
    },

    async find(id) {
      const row = await client.agent.findUnique({ where: { id } });
      return row ? storedAgent(row) : null;
    },

    async findByName(name) {
      const row = await client.agent.findUnique({ where: { name } });
      return row ? storedAgent(row) : null;
    },

    async findMany(ids) {
      const rows = await client.agent.findMany({ where: { id: { in: [...ids] } } });
      return rows.map(storedAgent);
    },

    async create(input) {
      try {
        return storedAgent(await client.agent.create({ data: input }));
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
        const adapterError = error.meta?.driverAdapterError as
          { cause?: { constraint?: { index?: string } } } | undefined;
        if (
          error.code === 'P2002' &&
          ((Array.isArray(error.meta?.target) && error.meta.target.includes('name')) ||
            adapterError?.cause?.constraint?.index === 'agents_name_key')
        ) {
          throw new DuplicateAgentNameError(input.name);
        }
        throw error;
      }
    },

    async update(id, patch) {
      return storedAgent(await client.agent.update({ where: { id }, data: patch }));
    },

    async memories(agentId) {
      const rows = await client.agentMemory.findMany({
        where: { agentId },
        orderBy: { sort: 'asc' },
      });
      const of = (type: AgentMemoryType) =>
        rows
          .filter((row) => memoryTypeOf(row.type) === type)
          .map((row) => ({ title: row.title, body: row.body }));

      return { persona: of(AGENT_MEMORY_TYPES.PERSONA), strategy: of(AGENT_MEMORY_TYPES.STRATEGY) };
    },

    async memoriesMany(ids) {
      const rows = await client.agentMemory.findMany({
        where: { agentId: { in: [...ids] } },
        orderBy: { sort: 'asc' },
      });
      const grouped = new Map<string, AgentMemories>();
      for (const row of rows) {
        const mine = grouped.get(row.agentId) ?? { persona: [], strategy: [] };
        mine[memoryTypeOf(row.type)].push({ title: row.title, body: row.body });
        grouped.set(row.agentId, mine);
      }

      // 要过的 id 一个不落：没写过人设的那几个给空的两类，读的人不必自己补。
      return new Map(
        ids.map((id) => [id, grouped.get(id) ?? { persona: [], strategy: [] }] as const),
      );
    },

    async replaceMemories(agentId, memories) {
      // 整批替换得在一个事务里：中间断掉会留下半份，而半份人设比没有更糟——它看着是完整的。
      await client.$transaction([
        client.agentMemory.deleteMany({ where: { agentId } }),
        client.agentMemory.createMany({ data: memoryRows(agentId, memories) }),
      ]);
    },
  };
}

/** 一行 agent 摊成存储那一头的样子。 */
function storedAgent(row: Prisma.AgentModel): StoredAgent {
  return {
    id: row.id,
    name: row.name,
    modelName: row.modelName,
    baseUrl: row.baseUrl,
    apiKeyCiphertext: row.apiKeyCiphertext,
    apiKeyHint: row.apiKeyHint,
    tag: row.tag,
    isActive: row.isActive,
    notes: row.notes,
  };
}

/** 两类条目摊成一串待写的行：sort 按各自在交上来那一份里的位置定。 */
function memoryRows(agentId: string, memories: AgentMemories): Prisma.AgentMemoryCreateManyInput[] {
  const rowsOf = (type: AgentMemoryType, items: readonly { title: string; body: string }[]) =>
    items.map((item, sort) => ({ agentId, type, sort, title: item.title, body: item.body }));

  return [
    ...rowsOf(AGENT_MEMORY_TYPES.PERSONA, memories.persona),
    ...rowsOf(AGENT_MEMORY_TYPES.STRATEGY, memories.strategy),
  ];
}

/**
 * 类别列由本层写进去，取值域就是 AGENT_MEMORY_TYPES；读到别的说明这行来路不明。
 * 认下它更糟：这一条既不进人设也不进策略，等于悄悄少了一条。
 */
function memoryTypeOf(value: string): AgentMemoryType {
  if (!Object.values(AGENT_MEMORY_TYPES).includes(value as AgentMemoryType)) {
    throw new Error(`人设与策略里有个不认识的类别：${value}`);
  }
  return value as AgentMemoryType;
}

/**
 * 事件库的真身。
 * 同一个键写第二遍交给库的唯一键挡，挡下来是抛：台账那边重放与同一趟里的重记各有拦处，
 * 能写到这一层说明有第二个写者在抢同一局，这时静默少一条，下一跑铺回来的台账就缺了一截。
 */
export function prismaEvents(client: PrismaClient): EventStore {
  return {
    positions: (gameId) =>
      client.gameEvent.findMany({
        where: { gameId },
        select: { eventKey: true, seq: true },
      }),
    async list(gameId, after = 0) {
      const rows = await client.gameEvent.findMany({
        where: { gameId, seq: { gt: after } },
        orderBy: { seq: 'asc' },
        select: { seq: true, eventKey: true, day: true, text: true, kind: true, audience: true },
      });
      return rows.map((row) => ({ ...row, kind: kindOf(row.kind) }));
    },

    async append(gameId, event) {
      // 一行不必走 createMany：它那个 skipDuplicates 正好会把唯一键冲突悄悄吞掉。
      // 受众在我们这边是只读的，落库那一层要的是可变数组，到这儿摊开一份。
      await client.gameEvent.create({ data: { gameId, ...event, audience: [...event.audience] } });
    },
  };
}

/**
 * 行动记录的真身。
 * 立意图用 upsert 配一个空的 update：重走同一问会把同一份意图再立一遍，
 * 先立那份原样留着——它记的是那一次提问，后来的重走改不了已经问过的那一次。
 */
export function prismaActions(client: PrismaClient): ActionStore {
  return {
    summaries: (gameId) => client.$queryRaw<StoredActionSummary[]>`
      SELECT action_key AS "actionKey", game_id AS "gameId",
        phase_instance_id AS "phaseInstanceId", action_type AS "actionType",
        actor_id AS "actorId", action_ordinal AS "actionOrdinal", ledger_seq AS "ledgerSeq", status,
        COALESCE(outcome #>> '{snapshot,reasoning}', '') <> '' AS "hasReasoning",
        CASE WHEN status = 'done' THEN jsonb_build_object('snapshot', jsonb_build_object(
          'context', jsonb_build_object(
            'task', outcome #> '{snapshot,context,task}',
            'day', outcome #> '{snapshot,context,day}',
            'actor', jsonb_build_object(
              'seatNo', outcome #> '{snapshot,context,actor,seatNo}',
              'role', outcome #> '{snapshot,context,actor,role}'
            )
          ),
          'decision', outcome #> '{snapshot,decision}',
          'thinkingMs', outcome #> '{snapshot,thinkingMs}'
        )) ELSE NULL END AS outcome
      FROM action_records WHERE game_id = ${gameId}
      ORDER BY created_at ASC, action_key ASC
    `,
    async find(actionKey) {
      const row = await client.actionRecord.findUnique({ where: { actionKey } });
      return row ? storedAction(row) : null;
    },

    async list(gameId) {
      const rows = await client.actionRecord.findMany({
        where: { gameId },
        // 并发提问可能同毫秒写入，用行动键固定同一批的显示次序。
        orderBy: [{ createdAt: 'asc' }, { actionKey: 'asc' }],
      });
      return rows.map(storedAction);
    },

    async begin(intent) {
      await client.actionRecord.upsert({
        where: { actionKey: intent.actionKey },
        create: {
          ...intent,
          experienceRetrieval: intent.experienceRetrieval
            ? (intent.experienceRetrieval as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
        update: {},
      });
    },

    async saveRetrieval(actionKey, previous, next) {
      const saved = await client.actionRecord.updateMany({
        where: {
          actionKey,
          experienceRetrieval: { equals: previous as unknown as Prisma.InputJsonValue },
        },
        data: { experienceRetrieval: next as unknown as Prisma.InputJsonValue },
      });
      if (saved.count !== 1) throw new Error('行动检索状态已变化，请恢复原行动');
    },

    async finish(actionKey, outcome) {
      await client.actionRecord.update({
        where: { actionKey },
        data: {
          status: 'done',
          outcome: outcome as Prisma.InputJsonValue,
          doneAt: new Date(),
        },
      });
    },
  };
}

/** 一行记录摊成存储那一头的样子：认一行与认一局用的是同一种行，摊法只此一份。 */
function storedAction(row: Prisma.ActionRecordModel): StoredAction {
  return {
    actionKey: row.actionKey,
    gameId: row.gameId,
    phaseInstanceId: row.phaseInstanceId,
    // 这一列由本层写进去，取值域就是行动类型，读回来不必再认一遍。
    actionType: row.actionType as ActionType,
    actorId: row.actorId,
    actionOrdinal: row.actionOrdinal,
    ledgerSeq: row.ledgerSeq,
    status: statusOf(row.status),
    outcome: row.outcome ?? null,
    experienceRetrieval: row.experienceRetrieval as unknown as StoredAction['experienceRetrieval'],
  };
}

/** 库里那一行摊成锚点。局面整份存的是 JSON：每个字段都可空、没有可选的，存读无损，认领回它的类型即可。 */
function anchorOf(row: {
  phaseInstanceId: string;
  state: Prisma.JsonValue;
  input: Prisma.JsonValue;
}): StageAnchor {
  return {
    phaseInstanceId: phaseInstanceIdOf(row.phaseInstanceId),
    state: row.state as unknown as GameState,
    input: row.input,
  };
}

/**
 * 阶段锚点的真身。
 * 同一格落第二遍不再写：重进那一格时序号不推进，落的是同一份，先落那份留着。
 * 取最后一份按落库先后排：每落一份中间都隔着一次落库往返，撞不上同一个时刻。
 */
export function prismaSteps(client: PrismaClient): StepStore {
  return {
    async last(gameId) {
      const row = await client.gameStep.findFirst({
        where: { gameId },
        orderBy: { createdAt: 'desc' },
      });
      return row ? anchorOf(row) : null;
    },

    async latest(gameIds) {
      if (gameIds.length === 0) return new Map();

      // 先只问键（一行两个短字段，一局几十格也没多大），再按这些键把局面取回来。
      // 图省事一次拉回整份局面按 gameId 挑头一个，等于为一屏卡片把每局的每一步都拖进内存。
      const keys = await client.gameStep.findMany({
        where: { gameId: { in: [...gameIds] } },
        select: { gameId: true, phaseInstanceId: true },
        orderBy: { createdAt: 'desc' },
      });
      // 新落的那一份排在前面，每局认头一个。
      const newest = new Map<string, string>();
      for (const key of keys) {
        if (!newest.has(key.gameId)) newest.set(key.gameId, key.phaseInstanceId);
      }

      // 一份锚点都没有（这几局全没开跑，或者整张表还空着）就到这儿为止：
      // 空的条件数组交下去要靠引擎自己去解释，不押这一注。
      if (newest.size === 0) return new Map();

      const rows = await client.gameStep.findMany({
        where: {
          OR: [...newest].map(([gameId, phaseInstanceId]) => ({ gameId, phaseInstanceId })),
        },
      });

      return new Map(rows.map((row) => [row.gameId, anchorOf(row)]));
    },

    async append(gameId, anchor) {
      await client.gameStep.upsert({
        where: { gameId_phaseInstanceId: { gameId, phaseInstanceId: anchor.phaseInstanceId } },
        create: {
          gameId,
          phaseInstanceId: anchor.phaseInstanceId,
          state: anchor.state as unknown as Prisma.InputJsonValue,
          input: anchor.input as Prisma.InputJsonValue,
        },
        update: {},
      });
    },
  };
}

/**
 * 提问记录的真身。
 * 每次重新采样都生成新 callId；重复写入同一编号由唯一约束拦下。
 */
export function prismaAsked(client: PrismaClient): AskedPromptStore {
  return {
    async experienceInputs(gameId, actionKey) {
      const rows = await client.askedPrompt.findMany({
        where: { gameId, actionKey, experiences: { not: Prisma.DbNull } },
        select: {
          callId: true,
          step: true,
          experiences: true,
          attempts: { select: { dispatched: true } },
        },
        orderBy: { id: 'asc' },
      });
      return rows.map((row) => ({
        callId: row.callId!,
        step: row.step!,
        dispatched: row.attempts.some((item) => item.dispatched === true),
        experiences: ExperienceSnapshotSchema.array().parse(row.experiences),
      }));
    },
    async finishCall(callId, result) {
      await client.askedPrompt.updateMany({
        where: { callId, status: 'started' },
        data: { ...result, finishedAt: new Date() },
      });
    },
    async append(gameId, asked) {
      const row = await client.askedPrompt.create({
        data: {
          gameId,
          actionKey: asked.actionKey,
          model: asked.model,
          system: asked.system,
          prompt: asked.prompt,
          summaryKey: asked.summaryKey,
          ...asked.observation,
          ...(asked.observation ? { status: 'started' } : {}),
          // 没走工具的那几问整列不写，落 SQL 的 null——不写才是「这一问压根没给工具」。
          ...(asked.tool ? { tool: asked.tool as unknown as Prisma.InputJsonValue } : {}),
          ...(asked.experiences
            ? { experiences: asked.experiences as unknown as Prisma.InputJsonValue }
            : {}),
        },
      });
      if (!asked.observation) return;
      return {
        async finish(result) {
          await client.askedPrompt.update({
            where: { id: row.id },
            data: { ...result, finishedAt: new Date() },
          });
        },
        async startAttempt(attemptNo) {
          await client.modelAttempt.create({ data: { askedPromptId: row.id, attemptNo } });
        },
        async finishAttempt(attemptNo, result) {
          await client.modelAttempt.update({
            where: { askedPromptId_attemptNo: { askedPromptId: row.id, attemptNo } },
            data: {
              ...result,
              usage:
                result.usage === null ? Prisma.DbNull : (result.usage as Prisma.InputJsonValue),
              finishedAt: new Date(),
            },
          });
        },
      };
    },
  };
}

/**
 * 类别列由本层写进去，取值域就是 EVENT_KINDS；读到别的说明这行来路不明。
 * 认下它更糟：分块时它跟哪一类都对不上，这条事实从所有人的提示词里悄没声地消失。
 */
function kindOf(value: string): EventKind {
  if (!Object.values(EVENT_KINDS).includes(value as EventKind)) {
    throw new Error(`事件里有个不认识的类别：${value}`);
  }
  return value as EventKind;
}

/** 身份列由本层写进去，形如 node/3/vote；读到别的说明这行来路不明，拿它当进度会接错格。 */
function phaseInstanceIdOf(value: string): PhaseInstanceId {
  const id = parsePhaseInstanceId(value);
  if (id === null) throw new Error(`阶段锚点里有个不认识的身份：${value}`);
  return id;
}

/** 状态只有这两档；读到别的说明库里的行来路不明，当成没答完接着跑会拿错答案。 */
function statusOf(value: string): 'running' | 'done' {
  if (value !== 'running' && value !== 'done')
    throw new Error(`行动记录里有个不认识的状态：${value}`);
  return value;
}

/**
 * 队列位置列由本层与队列写进去，取值域就是 shared 的 GAME_STATUSES。
 * 读到别的说明这行来路不明：当成「排队中」摆到列表上，会骗人去等一局永远不会开始的局。
 */
function gameStatusOf(value: string): GameStatus {
  if (!Object.values(GAME_STATUSES).includes(value as GameStatus)) {
    throw new Error(`对局档案里有个不认识的状态：${value}`);
  }
  return value as GameStatus;
}
