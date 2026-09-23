import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import {
  CreateGameRequestSchema,
  CreateGameResponseSchema,
  GAME_STATUSES,
  GameDetailResponseSchema,
  GameListResponseSchema,
  type CreateGameResponse,
  type GameDetailResponse,
  type GameListResponse,
  type GameRosterSeat,
  type GameSummary,
} from '@werewolf/shared';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { map, type Observable } from 'rxjs';
import { ALL_BOARDS, BOARD_IDS, handOf, type BoardId } from '../boards/boards';
import { shuffled } from '../boards/deal';
import { AdminTokenGuard } from '../common/guards/admin-token.guard';
import { parseBody } from '../common/parse-body';
import type { GameState, PlayerState } from '../core/state';
import { GameEventHub } from '../queue/game-event-hub';
import { GAME_QUEUE, type GameJob } from '../queue/game-queue';
import type { RosterSeat, StoredGame } from '../store/games';
import type { GameStores } from '../store/stores';
import { GAME_STORES } from '../store/stores.provider';
import { gameEvents, type Streamed } from './events-stream';

@Controller('games')
export class GamesController {
  constructor(
    @Inject(GAME_STORES) private readonly stores: GameStores,
    @InjectQueue(GAME_QUEUE) private readonly queue: Queue<GameJob>,
    private readonly hub: GameEventHub,
  ) {}

  /** 全部对局，新开的在前。 */
  @Get()
  async list(): Promise<GameListResponse> {
    const rows = await this.stores.games.list();
    // 一屏的存活人数与天数一次取回来，不挨个问。
    const anchors = await this.stores.steps.latest(
      rows.filter((row) => row.finalState === null).map((row) => row.gameId),
    );

    return GameListResponseSchema.parse({
      games: rows.map((row) =>
        summaryOf(row, row.finalState ?? anchors.get(row.gameId)?.state ?? null),
      ),
    });
  }

  /** 开一局：先立档再入队。档案立在前，任务里只放 id，板子回档案里读。 */
  @Post()
  @UseGuards(AdminTokenGuard)
  async create(@Body() body: unknown): Promise<CreateGameResponse> {
    const { boardId, agentIds } = parseBody(CreateGameRequestSchema, body);
    if (!BOARD_IDS.includes(boardId as BoardId)) {
      throw new BadRequestException(`没有这块板子：${boardId}`);
    }

    const gameId = newGameId();
    await this.stores.games.open({
      gameId,
      boardId,
      roster: agentIds === undefined ? [] : await this.seatsOf(boardId as BoardId, agentIds),
    });
    // 任务 id 就是对局 id：同一个 id 只会有一个任务在队列里。
    await this.queue.add('run', { gameId }, { jobId: gameId });

    return CreateGameResponseSchema.parse({ gameId });
  }

  /**
   * 续跑：把这一局重新排进队列，从最后一格接着跑。
   * 中途断掉的那一局（进程被杀、异常退出）就靠这一下接回来。
   */
  @Post(':gameId/run')
  @UseGuards(AdminTokenGuard)
  async run(@Param('gameId') gameId: string): Promise<CreateGameResponse> {
    const row = await this.stores.games.find(gameId);
    if (!row) throw new NotFoundException(`没有这一局：${gameId}`);
    if (row.winner) throw new BadRequestException(`这一局已经分出胜负：${row.winner}`);

    // 队列里那份还挂着的先清掉：同一个 id 加第二遍不会被受理。清不掉说明它这一刻正在跑。
    const job = await this.queue.getJob(gameId);
    if (job) {
      if (await job.isActive()) throw new BadRequestException(`这一局正在跑：${gameId}`);
      await job.remove();
    }

    // 状态先退回排队中：它还挂着「运行中」的话，看的人会以为这次没排上。
    await this.stores.games.setStatus(gameId, GAME_STATUSES.QUEUED);
    await this.queue.add('run', { gameId }, { jobId: gameId });

    return CreateGameResponseSchema.parse({ gameId });
  }

  /** 一局的档案，加上上帝视角才看得到的牌桌与阵容。 */
  @Get(':gameId')
  async detail(@Param('gameId') gameId: string): Promise<GameDetailResponse> {
    const row = await this.stores.games.find(gameId);
    if (!row) throw new NotFoundException(`没有这一局：${gameId}`);

    const state = row.finalState ?? (await this.stores.steps.last(gameId))?.state ?? null;

    return GameDetailResponseSchema.parse({
      game: {
        ...summaryOf(row, state),
        players: state?.players.map((p) => playerOf(p, state.sheriffId)) ?? [],
        roster: row.roster.map(seatOf),
      },
    });
  }

  /**
   * 开局时随机排座，结果随档案保存；续跑不重新排座。
   * 人数得正好是这块板子的人数——少一个多一个都是开局前就该知道的事。
   */
  private async seatsOf(boardId: BoardId, agentIds: readonly string[]): Promise<RosterSeat[]> {
    const seats = handOf(ALL_BOARDS[boardId]).length;
    if (agentIds.length !== seats) {
      throw new BadRequestException(
        `${boardId} 是 ${seats} 人局，给了 ${agentIds.length} 个 agent`,
      );
    }

    // 一次取回来再排座位，不逐个查。
    const byId = new Map(
      (await this.stores.agents.findMany(agentIds)).map((agent) => [agent.id, agent]),
    );

    return shuffled(agentIds, Math.random).map((agentId, index) => {
      const agent = byId.get(agentId);
      if (!agent) throw new BadRequestException(`没有这个 agent：${agentId}`);
      if (!agent.isActive)
        throw new BadRequestException(`这个 agent 停用了，开不了局：${agent.name}`);

      return {
        seatNo: index + 1,
        agentId,
        name: agent.name,
        modelName: agent.modelName,
        baseUrl: agent.baseUrl,
      };
    });
  }

  /**
   * 这一局的事实流，给观战页面接着看。
   * 断线重连靠 Last-Event-ID：浏览器把上次看到的 id 报回来，从它之后接着发。
   */
  @Sse(':gameId/events')
  events(
    @Param('gameId') gameId: string,
    @Headers('last-event-id') lastEventId?: string,
  ): Observable<MessageEvent> {
    // 报回来的不是个数就当没看过：从头发一遍总比重连之后再缺一段强。
    const parsed = Number(lastEventId ?? 0);
    const after = Number.isFinite(parsed) ? parsed : 0;

    return gameEvents({
      events: this.stores.events,
      hub: this.hub,
      gameId,
      after,
    }).pipe(map(messageOf));
  }
}

/**
 * 档案那一行摊成前端要的那几片；时间戳落成 ISO 串。
 * 存活人数与天数在局面里，还没落过锚点（刚开局那一小会儿）就是 null。
 */
function summaryOf(row: StoredGame, state: GameState | null): GameSummary {
  return {
    gameId: row.gameId,
    boardId: row.boardId,
    status: row.status,
    winner: row.winner as GameSummary['winner'],
    createdAt: row.createdAt.toISOString(),
    aliveCount: state ? state.players.filter((player) => player.isAlive).length : null,
    day: state?.day ?? null,
  };
}

/** 阵容摊成前端要的那几片：座位、是谁、用的哪个型号。端点与密钥不出这一层。 */
function seatOf(seat: RosterSeat): GameRosterSeat {
  return {
    seatNo: seat.seatNo,
    agentId: seat.agentId,
    name: seat.name,
    modelName: seat.modelName,
  };
}

/** 上帝视角看一个人：座位、牌、阵营、还活着没有，出局的话加上天数与死因。 */
function playerOf(player: PlayerState, sheriffId: string | null) {
  return {
    id: player.id,
    seatNo: player.seatNo,
    role: player.role,
    faction: player.faction,
    isAlive: player.isAlive,
    deathDay: player.deathDay,
    deathCause: player.deathCause,
    isSheriff: player.id === sheriffId,
  };
}

/**
 * 一条消息发出去的样子。
 * 事实拿 seq 当 SSE 的 id，重连时原样报回来。
 *
 * 预览另起一个事件名，前端按它分流；它的 id 是「事实已发到哪一条」，不是自己的序号——
 * 预览没有序号。这个 id 不能省：Nest 的 SseStream 会给没有 id 的消息补一个每连接自增的号
 * （`@nestjs/core/router/sse-stream.js` 里 `lastEventId++`），那个号一路涨过台账末尾之后，
 * 前端把它当断点报回来，之后的事实就全被 `seq > after` 挡掉了。
 */
function messageOf(message: Streamed): MessageEvent {
  if ('preview' in message) {
    return { data: message.preview, type: 'preview', id: String(message.sent) };
  }

  return { data: message.event, id: String(message.event.seq) };
}

/** 新一局的 id：日期加一段随机尾巴，一眼看得出来是哪天开的。 */
function newGameId(now: Date = new Date()): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');

  return `g-${stamp}-${randomUUID().slice(0, 6)}`;
}
