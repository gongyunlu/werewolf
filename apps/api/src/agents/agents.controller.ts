import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  CreateAgentRequestSchema,
  ReplaceAgentMemoriesRequestSchema,
  UpdateAgentRequestSchema,
  type AgentListResponse,
  type AgentMemoriesResponse,
  type AgentResponse,
} from '@werewolf/shared';
import { AdminTokenGuard } from '../common/guards/admin-token.guard';
import { parseBody } from '../common/parse-body';
import { AgentsService } from './agents.service';

/** 读接口不挂守卫：这些配置本来就是给自己看的。写接口全挂。 */
@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  /** includeInactive=true 连停用的一起给，管理页要看到它们。 */
  @Get()
  async list(@Query('includeInactive') includeInactive?: string): Promise<AgentListResponse> {
    return this.agents.list(includeInactive === 'true');
  }

  @Get(':agentId')
  async get(@Param('agentId') agentId: string): Promise<AgentResponse> {
    return this.agents.get(agentId);
  }

  @Post()
  @UseGuards(AdminTokenGuard)
  async create(@Body() body: unknown): Promise<AgentResponse> {
    return this.agents.create(parseBody(CreateAgentRequestSchema, body));
  }

  @Patch(':agentId')
  @UseGuards(AdminTokenGuard)
  async update(@Param('agentId') agentId: string, @Body() body: unknown): Promise<AgentResponse> {
    return this.agents.update(agentId, parseBody(UpdateAgentRequestSchema, body));
  }

  @Get(':agentId/memories')
  async memories(@Param('agentId') agentId: string): Promise<AgentMemoriesResponse> {
    return this.agents.memories(agentId);
  }

  /** 整批替换：交上来的就是全集。 */
  @Put(':agentId/memories')
  @UseGuards(AdminTokenGuard)
  async replaceMemories(
    @Param('agentId') agentId: string,
    @Body() body: unknown,
  ): Promise<AgentMemoriesResponse> {
    return this.agents.replaceMemories(agentId, parseBody(ReplaceAgentMemoriesRequestSchema, body));
  }
}
