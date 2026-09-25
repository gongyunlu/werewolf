import {
  ActionSummaryResponseSchema,
  ActionDetailResponseSchema,
  AgentListResponseSchema,
  AgentMemoriesResponseSchema,
  AgentResponseSchema,
  BoardListResponseSchema,
  CreateGameResponseSchema,
  GameDetailResponseSchema,
  GameListResponseSchema,
  HealthResponseSchema,
  ReviewPreviewSchema,
  ReviewResponseSchema,
  ReviewStartResponseSchema,
  type AgentListResponse,
  type AgentMemories,
  type AgentMemoriesResponse,
  type AgentResponse,
  type BoardListResponse,
  type CreateAgentRequest,
  type CreateGameResponse,
  type GameDetailResponse,
  type GameListResponse,
  type HealthResponse,
  type UpdateAgentRequest,
} from '@werewolf/shared';
import { adminHeaders } from './admin-token';
import { http } from './http';

export async function fetchReviewPreview(gameId: string, signal?: AbortSignal) {
  return http.get(`/games/${gameId}/review/preview`, { schema: ReviewPreviewSchema, signal });
}

export async function fetchReview(gameId: string, signal?: AbortSignal) {
  return http.get(`/games/${gameId}/review`, { schema: ReviewResponseSchema, signal });
}

export async function startReview(gameId: string) {
  return http.post(`/games/${gameId}/review`, undefined, {
    schema: ReviewStartResponseSchema,
    headers: adminHeaders(),
  });
}

export async function fetchActionSummaries(gameId: string) {
  return http.get(`/games/${gameId}/actions/summaries`, { schema: ActionSummaryResponseSchema });
}

export async function fetchActionDetail(gameId: string, actionKey: string) {
  return http.get(`/games/${gameId}/actions/detail`, {
    params: { actionKey },
    schema: ActionDetailResponseSchema,
  });
}

export async function fetchHealth(): Promise<HealthResponse> {
  return http.get('/health', { schema: HealthResponseSchema });
}

export async function fetchBoards(): Promise<BoardListResponse> {
  return http.get('/boards', { schema: BoardListResponseSchema });
}

export async function fetchGames(): Promise<GameListResponse> {
  return http.get('/games', { schema: GameListResponseSchema });
}

/** 不给 agentIds 就是整局走环境变量那一套接入。 */
export async function createGame(
  boardId: string,
  agentIds?: readonly string[],
): Promise<CreateGameResponse> {
  return http.post(
    '/games',
    { boardId, agentIds },
    {
      schema: CreateGameResponseSchema,
      headers: adminHeaders(),
    },
  );
}

/** 续跑：把断了的那一局重新排进队列。 */
export async function runGame(gameId: string): Promise<CreateGameResponse> {
  return http.post(`/games/${gameId}/run`, undefined, {
    schema: CreateGameResponseSchema,
    headers: adminHeaders(),
  });
}

export async function fetchGameDetail(gameId: string): Promise<GameDetailResponse> {
  return http.get(`/games/${gameId}`, { schema: GameDetailResponseSchema });
}

/** 管理页要把停用的也列出来。 */
export async function fetchAgents(includeInactive = false): Promise<AgentListResponse> {
  return http.get('/agents', {
    params: { includeInactive: String(includeInactive) },
    schema: AgentListResponseSchema,
  });
}

export async function createAgent(body: CreateAgentRequest): Promise<AgentResponse> {
  return http.post('/agents', body, { schema: AgentResponseSchema, headers: adminHeaders() });
}

export async function updateAgent(
  agentId: string,
  body: UpdateAgentRequest,
): Promise<AgentResponse> {
  return http.patch(`/agents/${agentId}`, body, {
    schema: AgentResponseSchema,
    headers: adminHeaders(),
  });
}

export async function fetchAgentMemories(agentId: string): Promise<AgentMemoriesResponse> {
  return http.get(`/agents/${agentId}/memories`, { schema: AgentMemoriesResponseSchema });
}

export async function replaceAgentMemories(
  agentId: string,
  memories: AgentMemories,
): Promise<AgentMemoriesResponse> {
  return http.put(`/agents/${agentId}/memories`, memories, {
    schema: AgentMemoriesResponseSchema,
    headers: adminHeaders(),
  });
}
