import { z } from 'zod';

/** 一个参赛者的持久身份：名字、默认型号、从哪接入。坐哪一格由开局那份阵容定。 */
export const AgentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  modelName: z.string(),
  /** 接入端点；null 表示用环境变量那一套默认接入。 */
  baseUrl: z.string().nullable(),
  /**
   * 自带密钥的末四位；没配就是 null。
   * 密钥本身一个字都不进这条契约——密文只写不读，读接口给到末四位就够认出是哪一把。
   */
  apiKeyHint: z.string().nullable(),
  tag: z.string().nullable(),
  /** 停用的不再能开局，历史对局里那份阵容快照照旧算数。 */
  isActive: z.boolean(),
  notes: z.string().nullable(),
});

export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const AgentListResponseSchema = z.object({ agents: z.array(AgentSummarySchema) });

export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;

export const AgentResponseSchema = z.object({ agent: AgentSummarySchema });

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

/**
 * 建一个 agent。
 * name 与 modelName 必给；端点与自带密钥成对——自带密钥要自带端点，
 * 拿人家的密钥去默认端点上是配错了，当场拒掉。
 */
export const CreateAgentRequestSchema = z.object({
  name: z.string().min(1).max(64),
  modelName: z.string().min(1).max(64),
  baseUrl: z.string().min(1).max(512).nullable().optional(),
  apiKey: z.string().min(1).max(512).nullable().optional(),
  tag: z.string().max(64).nullable().optional(),
  notes: z.string().nullable().optional(),
});

export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

/**
 * 改一个 agent。名字不在可改之列：它是对局里认人的那一个，改了对不上历史。
 * apiKey 三态——不传保持原样、给 null 清掉、给值换掉；掩码不会被当成新密钥存回来。
 */
export const UpdateAgentRequestSchema = z.object({
  modelName: z.string().min(1).max(64).optional(),
  baseUrl: z.string().min(1).max(512).nullable().optional(),
  apiKey: z.string().min(1).max(512).nullable().optional(),
  tag: z.string().max(64).nullable().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

/** 人设与策略这两类条目的取值。 */
export const AGENT_MEMORY_TYPES = {
  PERSONA: 'persona',
  STRATEGY: 'strategy',
} as const;

export type AgentMemoryType = (typeof AGENT_MEMORY_TYPES)[keyof typeof AGENT_MEMORY_TYPES];

/** 一个人的人设加策略合计最多几条。两侧共用这一条数，不各写一份。 */
export const AGENT_MEMORY_LIMIT = 20;

/** 一条人设或策略。标题那一列是 VarChar(64)，超了要先在这儿拦下。 */
export const AgentMemoryItemSchema = z.object({
  title: z.string().min(1, '标题不能为空').max(64, '标题最多 64 个字'),
  body: z.string().min(1, '正文不能为空'),
});

export type AgentMemoryItem = z.infer<typeof AgentMemoryItemSchema>;

/** 人设与策略，按类分开、各自有序——顺序本身就是内容的一部分。 */
export const AgentMemoriesSchema = z.object({
  persona: z.array(AgentMemoryItemSchema),
  strategy: z.array(AgentMemoryItemSchema),
});

export type AgentMemories = z.infer<typeof AgentMemoriesSchema>;

export const AgentMemoriesResponseSchema = z.object({ memories: AgentMemoriesSchema });

export type AgentMemoriesResponse = z.infer<typeof AgentMemoriesResponseSchema>;

/**
 * 整批替换：交上来的就是完整一份，没交的等于删掉。
 * 不单独开口子增删单条——顺序一变整份都要重排。
 */
export const ReplaceAgentMemoriesRequestSchema = AgentMemoriesSchema.refine(
  (memories) => memories.persona.length + memories.strategy.length <= AGENT_MEMORY_LIMIT,
  `人设与策略合计最多 ${AGENT_MEMORY_LIMIT} 条`,
);

export type ReplaceAgentMemoriesRequest = z.infer<typeof ReplaceAgentMemoriesRequestSchema>;
