import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { GAME_STATUSES } from '@werewolf/shared';
import type { Job } from 'bullmq';
import { BOARD_IDS, type BoardId } from '../boards/boards';
import { createGameSetup } from '../boards/setup';
import { loadEnv } from '../config/env';
import { modelRuntimeOf, promptSourceOf } from '../llm/from-env';
import { gameSkills } from '../skills/game-skills';
import { seatContextOf } from '../agents/seat-context';
import type { GameStores } from '../store/stores';
import { GAME_STORES } from '../store/stores.provider';
import { runStoredGame } from '../turn/run-stored-game';
import { GameEventHub } from './game-event-hub';
import { GAME_QUEUE, type GameJob } from './game-queue';

/** 一次只跑一局：模型调用是一局里最慢的一段，两局并行只会互相拖慢。 */
const CONCURRENCY = 1;

/**
 * 队列上跑对局的那一头。
 * 跟接口同进程：跑的是同一份存储、同一个事件中转，中间不用再跨一次进程。
 */
@Processor(GAME_QUEUE, { concurrency: CONCURRENCY })
export class GameWorker extends WorkerHost {
  private readonly logger = new Logger(GameWorker.name);
  private readonly stores: GameStores;

  constructor(
    @Inject(GAME_STORES) stores: GameStores,
    private readonly hub: GameEventHub,
  ) {
    super();

    const append = stores.events.append.bind(stores.events);
    // 台账是给恢复用的，观战看的是实时那份：落库之后往频道上推一条。
    // 只包一份不带改原件：原件还给读接口用，不该知道有人在推流。
    this.stores = {
      ...stores,
      events: {
        ...stores.events,
        append: async (gameId, event) => {
          this.logger.log(`${gameId}｜${event.day} 天｜${event.text}`);
          await append(gameId, event);
          // 推不出去不算这一局出错：台账是事实的那一份，看的人重连时从台账补齐。
          // 撂在这儿只会把一局跑了半天的对局带走。
          await this.hub.publish(gameId, event).catch((error: unknown) => {
            this.logger.error(`推事件失败：${gameId}`, error);
          });
        },
      },
    };
  }

  async process(job: Job<GameJob>): Promise<void> {
    const { gameId } = job.data;
    const stored = await this.stores.games.find(gameId);
    if (!stored) throw new Error(`队列里这一局没有档案：${gameId}`);

    // 板子是建档时定下的，读回来再认一遍：认不出这块板子就取不到规则正文，跑下去也是空转。
    const boardId = stored.boardId;
    if (!BOARD_IDS.includes(boardId as BoardId)) throw new Error(`没有这块板子：${boardId}`);

    const env = loadEnv();
    const { port, access } = modelRuntimeOf(env);
    const setup = createGameSetup({ gameId, boardId: boardId as BoardId, random: Math.random });

    // 谁在答就用谁那份接入与人设：开局那份阵容里排了人的格子各有各的，没排人的共用环境变量那份。
    const seatContext = await seatContextOf({
      env,
      roster: stored.roster,
      agents: this.stores.agents,
      fallback: access,
    });

    const result = await runStoredGame({
      setup,
      playerIds: setup.seats.map((seat) => `p${seat.seatNo}`),
      runtime: {
        port,
        ...seatContext,
        skills: gameSkills(boardId as BoardId),
        // 推不出去不算这一局出错，跟落库那条一个道理：预览是过程，丢了只是观战那头少看一段。
        preview: (chunk) => {
          void this.hub.publishPreview(gameId, chunk).catch((error: unknown) => {
            this.logger.error(`推预览失败：${gameId}`, error);
          });
        },
      },
      promptSource: promptSourceOf(env),
      // 发言方向按真实分钟定：时钟在核心外面，核心只收结果。
      minuteOf: () => new Date().getMinutes(),
      stores: this.stores,
    });

    this.logger.log(`${gameId} 跑完，胜方 ${result.winner}，共问 ${result.outcomes.length} 次`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<GameJob> | undefined, error: Error): Promise<void> {
    this.logger.error(`对局任务失败：${job?.data.gameId ?? '任务已移除'}`, error.stack);
    if (!job) return;

    // 失锁次数超限时 BullMQ 不会调用 process，也要把档案标成中断。
    const { gameId } = job.data;
    const current = await this.stores.games.find(gameId);
    if (current && current.status !== GAME_STATUSES.FINISHED) {
      await this.stores.games.setStatus(gameId, GAME_STATUSES.FAILED);
    }
  }
}
