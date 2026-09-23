import { z } from 'zod';
import { FACTIONS } from '../domain/factions';

/** 建局时能选的板子。名字与人数从板子配置现读，前端不另存一份。 */
export const BoardSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  playerCount: z.number(),
  hasSheriff: z.boolean(),
});

export type BoardSummary = z.infer<typeof BoardSummarySchema>;

export const BoardListResponseSchema = z.object({
  boards: z.array(BoardSummarySchema),
});

export type BoardListResponse = z.infer<typeof BoardListResponseSchema>;

/**
 * 一局在队列上的位置。没上过队列（CLI 直接跑完的）也是 finished。
 * queued 与 running 的区别只在「轮到了没有」，观战页不用它做判断。
 */
export const GAME_STATUSES = {
  QUEUED: 'queued',
  RUNNING: 'running',
  FINISHED: 'finished',
  FAILED: 'failed',
} as const;

export type GameStatus = (typeof GAME_STATUSES)[keyof typeof GAME_STATUSES];

export const GameSummarySchema = z.object({
  gameId: z.string(),
  boardId: z.string(),
  status: z.enum(Object.values(GAME_STATUSES)),
  /** 胜方阵营；没结束是 null。 */
  winner: z.enum(Object.values(FACTIONS)).nullable(),
  /** 建档那一刻，ISO 串。 */
  createdAt: z.string(),
  /** 牌桌上还有几个人活着；还没发牌是 null。 */
  aliveCount: z.number().nullable(),
  /** 走到第几天；还没发牌是 null。 */
  day: z.number().nullable(),
});

export type GameSummary = z.infer<typeof GameSummarySchema>;

export const GameListResponseSchema = z.object({
  games: z.array(GameSummarySchema),
});

export type GameListResponse = z.infer<typeof GameListResponseSchema>;

/**
 * 开一局。agentIds 只表示参赛名单，座次由服务端随机分配。
 * 不给就是整局走环境变量那一套接入——命令行跑的那些局正是这样，这条不是兜底是另一种正常跑法。
 */
export const CreateGameRequestSchema = z.object({
  boardId: z.string(),
  agentIds: z.array(z.string()).min(1).optional(),
});

export type CreateGameRequest = z.infer<typeof CreateGameRequestSchema>;

export const CreateGameResponseSchema = z.object({
  gameId: z.string(),
});

export type CreateGameResponse = z.infer<typeof CreateGameResponseSchema>;

/**
 * 一条对局事件，观战用的那几项。
 * kind 只当字符串：取值域留在 api 侧的 store 里，不为了这条契约搬一次域；
 * 前端认得的那几类照自己的样式显示，不认识的当普通行渲染。
 */
export const GameEventSchema = z.object({
  /** 局内的第几条，也是 SSE 的 id，断线重连靠它接上。 */
  seq: z.number(),
  day: z.number(),
  kind: z.string(),
  /** 法官播报携带实际昼夜阶段，旧记录可能没有。 */
  phase: z.string().optional(),
  text: z.string(),
  /** 这条事件原本谁看得到，用于筛选观战视角，不显示名单，也不当权限用。 */
  audience: z.array(z.string()),
});

export type GameEvent = z.infer<typeof GameEventSchema>;

/**
 * 正在生成的这一段：模型一边写，观战页一边冒字。
 *
 * 它不是事实——不落库、不进台账，也没有 seq，随时可以被丢掉再等下一段。
 * text 是这一路到目前的全文而不是增量：丢一段、重复一段都不影响显示，
 * 断了接回来也从下一片起就跟上，不必把中间那几片重放一遍。
 */
const PreviewBaseSchema = z.object({
  thinkingMs: z.number().nonnegative().optional(),
  actionKey: z.string(),
  day: z.number(),
  seatNo: z.number(),
  actionType: z.string(),
  /** 走到图里哪一步：生成、复核还是重做。 */
  step: z.string(),
  /** 这一趟是第几次问模型。换了它就是新的一趟，之前那版的字不作数。 */
  callId: z.string(),
  /** 这一路到目前的全文。 */
  text: z.string(),
});

export const PreviewChunkSchema = z.discriminatedUnion('channel', [
  PreviewBaseSchema.extend({ channel: z.enum(['reasoning', 'content']) }),
  PreviewBaseSchema.extend({
    channel: z.literal('node'),
    status: z.enum(['running', 'completed', 'failed']),
  }),
]);

export type PreviewChunk = z.infer<typeof PreviewChunkSchema>;

/**
 * 上帝视角看得到的一名玩家。
 * role 只当字符串：能发的那几张牌在 api 侧（DEALABLE_ROLES），不为了这条契约搬一次域。
 */
export const GamePlayerSchema = z.object({
  id: z.string(),
  seatNo: z.number(),
  role: z.string(),
  faction: z.enum(Object.values(FACTIONS)),
  isAlive: z.boolean(),
  /** 死亡天数；活着是 null。 */
  deathDay: z.number().nullable(),
  /**
   * 死因；活着是 null。
   * 同样只当字符串：取值域在 api 侧的 DEATH_CAUSES，不为了这条契约搬一次域。
   */
  deathCause: z.string().nullable(),
  /** 警长是不是他。没设警长、或者还没选出来都是 false。 */
  isSheriff: z.boolean(),
});

export type GamePlayer = z.infer<typeof GamePlayerSchema>;

/**
 * 开局那一刻定下的阵容：哪一格坐着谁、给他用哪个型号。
 * 端点与密钥不在这条契约里——那是服务端算接入身份用的，前端不需要知道。
 */
export const GameRosterSeatSchema = z.object({
  seatNo: z.number(),
  agentId: z.string(),
  /** 显示名，取开局那一刻的 agent 名字。 */
  name: z.string(),
  /** 这一局给他用的型号，开局那一刻冻下。 */
  modelName: z.string(),
});

export type GameRosterSeat = z.infer<typeof GameRosterSeatSchema>;

/** 一局的详情：档案那几项，加上上帝视角才看得到的那张牌桌与阵容。 */
export const GameDetailSchema = GameSummarySchema.extend({
  /** 开局那一刻发下去的牌；还没开局是空数组。 */
  players: z.array(GamePlayerSchema),
  /** 阵容；没指定 agent 开的局是空数组。 */
  roster: z.array(GameRosterSeatSchema),
});

export type GameDetail = z.infer<typeof GameDetailSchema>;

export const GameDetailResponseSchema = z.object({
  game: GameDetailSchema,
});

export type GameDetailResponse = z.infer<typeof GameDetailResponseSchema>;
