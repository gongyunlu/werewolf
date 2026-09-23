import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AgentListResponseSchema,
  AgentMemoriesResponseSchema,
  AgentResponseSchema,
  type AgentListResponse,
  type AgentMemoriesResponse,
  type AgentResponse,
  type CreateAgentRequest,
  type ReplaceAgentMemoriesRequest,
  type UpdateAgentRequest,
} from '@werewolf/shared';
import { loadEnv } from '../config/env';
import { DuplicateAgentNameError, type AgentPatch, type StoredAgent } from '../store/agents';
import type { GameStores } from '../store/stores';
import { GAME_STORES } from '../store/stores.provider';
import { agentSecretCrypto } from './agent-secret';

@Injectable()
export class AgentsService {
  constructor(@Inject(GAME_STORES) private readonly stores: GameStores) {}

  /** 全部 agent。默认只给启用的——列表上不摆开不了局的那些。 */
  async list(includeInactive: boolean): Promise<AgentListResponse> {
    const rows = await this.stores.agents.list(includeInactive);

    return AgentListResponseSchema.parse({ agents: rows.map(agentView) });
  }

  async get(agentId: string): Promise<AgentResponse> {
    return AgentResponseSchema.parse({ agent: agentView(await this.require(agentId)) });
  }

  /** 建一个。端点与自带密钥成对：自带密钥要自带端点，只配一半等于配错。 */
  async create(request: CreateAgentRequest): Promise<AgentResponse> {
    const baseUrl = request.baseUrl ?? null;
    const apiKey = request.apiKey ?? null;

    if ((baseUrl === null) !== (apiKey === null)) {
      throw new BadRequestException('接入端点与自带密钥要么都给，要么都不给');
    }
    try {
      const agent = await this.stores.agents.create({
        name: request.name,
        modelName: request.modelName,
        baseUrl,
        tag: request.tag ?? null,
        notes: request.notes ?? null,
        ...(apiKey === null ? { apiKeyCiphertext: null, apiKeyHint: null } : keyOf(apiKey)),
      });

      return AgentResponseSchema.parse({ agent: agentView(agent) });
    } catch (error) {
      if (error instanceof DuplicateAgentNameError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /**
   * 改一个。
   * 密钥三态：请求里没这一项就保持原样、给 null 清掉、给值换掉。
   * 名字改不了，不在可改之列——它是对局里认人的那一个。
   */
  async update(agentId: string, request: UpdateAgentRequest): Promise<AgentResponse> {
    const existing = await this.require(agentId);
    const patch: AgentPatch = {};

    if (request.modelName !== undefined) patch.modelName = request.modelName;
    if (request.baseUrl !== undefined) patch.baseUrl = request.baseUrl;
    if (request.tag !== undefined) patch.tag = request.tag;
    if (request.notes !== undefined) patch.notes = request.notes;
    if (request.isActive !== undefined) patch.isActive = request.isActive;
    if (request.apiKey !== undefined) {
      Object.assign(
        patch,
        request.apiKey === null
          ? { apiKeyCiphertext: null, apiKeyHint: null }
          : keyOf(request.apiKey),
      );
    }

    // 判的是改完之后那一份：端点与密钥要一起在、一起不在，缺一半就先拦住，别等开局才发现。
    const baseUrl = patch.baseUrl === undefined ? existing.baseUrl : patch.baseUrl;
    const keyed =
      (patch.apiKeyCiphertext === undefined
        ? existing.apiKeyCiphertext
        : patch.apiKeyCiphertext) !== null;

    if ((baseUrl !== null) !== keyed) {
      throw new BadRequestException('接入端点与自带密钥要一起给、一起清');
    }

    return AgentResponseSchema.parse({
      agent: agentView(await this.stores.agents.update(agentId, patch)),
    });
  }

  /** 这个人的全部人设与策略。 */
  async memories(agentId: string): Promise<AgentMemoriesResponse> {
    await this.require(agentId);

    return AgentMemoriesResponseSchema.parse({
      memories: await this.stores.agents.memories(agentId),
    });
  }

  /** 整批替换人设与策略，交上来的就是全集。 */
  async replaceMemories(
    agentId: string,
    request: ReplaceAgentMemoriesRequest,
  ): Promise<AgentMemoriesResponse> {
    await this.require(agentId);
    await this.stores.agents.replaceMemories(agentId, request);

    return this.memories(agentId);
  }

  /** 取一个 agent 回来，没有就 404——改成改一个不存在的东西，报的该是「没这个人」。 */
  private async require(agentId: string): Promise<StoredAgent> {
    const row = await this.stores.agents.find(agentId);
    if (!row) throw new NotFoundException(`没有这个 agent：${agentId}`);

    return row;
  }
}

/** 要存进去的那两列：密文与末四位。末四位只为在界面上认出配的是哪一把。 */
function keyOf(apiKey: string): { apiKeyCiphertext: string; apiKeyHint: string } {
  return {
    apiKeyCiphertext: agentSecretCrypto(loadEnv().AGENT_SECRET_KEY).encrypt(apiKey),
    apiKeyHint: apiKey.slice(-4),
  };
}

/** 交出去的样子。密文一个字都不给，只给末四位。 */
function agentView(agent: StoredAgent) {
  return {
    id: agent.id,
    name: agent.name,
    modelName: agent.modelName,
    baseUrl: agent.baseUrl,
    apiKeyHint: agent.apiKeyHint,
    tag: agent.tag,
    isActive: agent.isActive,
    notes: agent.notes,
  };
}
