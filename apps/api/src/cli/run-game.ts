import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { BOARD_IDS, type BoardId } from '../boards/boards';
import { createGameSetup } from '../boards/setup';
import { loadEnv } from '../config/env';
import { loadEnvFiles } from '../config/env-files';
import { modelRuntimeOf, promptSourceOf } from '../llm/from-env';
import { gameSkills } from '../skills/game-skills';
import { openPrismaClient, prismaStores } from '../store/prisma';
import { runStoredGame } from '../turn/run-stored-game';

/**
 * 手动跑一局真对局：pnpm --filter @werewolf/api game <对局id> [板子id]。
 * 同一个 id 再跑一次就是接着那一局往下跑；它已经分出胜负的话会当场告诉你，不用重复问模型。
 */
async function main(): Promise<void> {
  loadEnvFiles();
  const env = loadEnv();
  const [gameId, boardId = BOARD_IDS[0]] = process.argv.slice(2);
  if (!gameId) throw new Error('用法：game <对局id> [板子id]');
  if (!BOARD_IDS.includes(boardId as BoardId)) throw new Error(`没有这块板子：${boardId}`);

  const client = openPrismaClient(env.DATABASE_URL);
  try {
    const stores = prismaStores(client);
    // 台账照原样落库，另外打一份到终端：一局要跑十几分钟，得看得见它走到哪儿了。
    const append = stores.events.append.bind(stores.events);
    stores.events.append = async (id, event) => {
      Logger.log(`${event.day} 天｜${event.text}`, gameId);
      await append(id, event);
    };

    const setup = createGameSetup({ gameId, boardId: boardId as BoardId, random: Math.random });
    const { port, access } = modelRuntimeOf(env);
    const result = await runStoredGame({
      setup,
      playerIds: setup.seats.map((seat) => `p${seat.seatNo}`),
      runtime: { port, access, skills: gameSkills(boardId as BoardId) },
      promptSource: promptSourceOf(env),
      // 发言方向按真实分钟定：时钟在核心外面，核心只收结果。
      minuteOf: () => new Date().getMinutes(),
      stores,
    });

    Logger.log(`胜方：${result.winner}；共问 ${result.outcomes.length} 次`, gameId);
  } finally {
    await client.$disconnect();
  }
}

void main();
