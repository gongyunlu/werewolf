import { PrismaPg } from '@prisma/adapter-pg';
import type { ActionType } from '@werewolf/shared';
import { parsePhaseInstanceId, type PhaseInstanceId } from '../core/identity';
import type { GameState } from '../core/state';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import type { ActionStore, StoredAction } from './actions';
import type { AskedPromptStore } from './asked';
import { prismaCheckpoints } from './checkpoints';
import { EVENT_KINDS, type EventKind, type EventStore } from './events';
import type { GameStore } from './games';
import type { StepStore } from './steps';
import type { GameStores } from './stores';

/** 连上对局库。调用方用完自己关。 */
export function openPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export function prismaStores(client: PrismaClient): GameStores {
  return {
    games: prismaGames(client),
    events: prismaEvents(client),
    actions: prismaActions(client),
    steps: prismaSteps(client),
    asked: prismaAsked(client),
    checkpoints: prismaCheckpoints(client),
  };
}

/** 对局档案的真身。 */
export function prismaGames(client: PrismaClient): GameStore {
  return {
    async find(gameId) {
      const row = await client.game.findUnique({ where: { id: gameId } });
      if (!row) return null;
      return { gameId: row.id, boardId: row.boardId, winner: row.winner };
    },

    async open(game) {
      await client.game.upsert({
        where: { id: game.gameId },
        create: { id: game.gameId, boardId: game.boardId },
        // 已经立过档的留着：它记的是开局那一刻，重开一次不该把它换掉。
        update: {},
      });
    },

    async finish(gameId, winner) {
      await client.game.update({ where: { id: gameId }, data: { winner } });
    },
  };
}

/**
 * 事件库的真身。
 * 同一个键写第二遍交给库的唯一键挡，挡下来是抛：台账那边重放与同一趟里的重记各有拦处，
 * 能写到这一层说明有第二个写者在抢同一局，这时静默少一条，下一跑铺回来的台账就缺了一截。
 */
export function prismaEvents(client: PrismaClient): EventStore {
  return {
    async list(gameId) {
      const rows = await client.gameEvent.findMany({
        where: { gameId },
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
    async find(actionKey) {
      const row = await client.actionRecord.findUnique({ where: { actionKey } });
      return row ? storedAction(row) : null;
    },

    async list(gameId) {
      const rows = await client.actionRecord.findMany({
        where: { gameId },
        // 按落库先后排，跟阶段锚点一个道理：每落一行中间都隔着一次落库往返，撞不上同一个时刻。
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(storedAction);
    },

    async begin(intent) {
      await client.actionRecord.upsert({
        where: { actionKey: intent.actionKey },
        create: intent,
        update: {},
      });
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
      if (!row) return null;
      return {
        phaseInstanceId: phaseInstanceIdOf(row.phaseInstanceId),
        // 局面整份存的是 JSON：每个字段都可空、没有可选的，存读无损，认领回它的类型即可。
        state: row.state as unknown as GameState,
        input: row.input,
      };
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
 * 一律 create、不 upsert：同一问重问几遍就该有几行，这是全仓唯一一张不认重的表。
 */
export function prismaAsked(client: PrismaClient): AskedPromptStore {
  return {
    async append(gameId, asked) {
      await client.askedPrompt.create({
        data: {
          gameId,
          actionKey: asked.actionKey,
          model: asked.model,
          system: asked.system,
          prompt: asked.prompt,
          // 没走工具的那几问整列不写，落 SQL 的 null——不写才是「这一问压根没给工具」。
          ...(asked.tool ? { tool: asked.tool as unknown as Prisma.InputJsonValue } : {}),
        },
      });
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
