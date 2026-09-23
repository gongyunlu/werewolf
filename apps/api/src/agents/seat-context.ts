import type { AgentMemories } from '@werewolf/shared';
import type { AppEnv } from '../config/env';
import { resolveModelCapability } from '../llm/model-capability';
import type { ModelAccess } from '../llm/model-port';
import type { AgentStore, StoredAgent } from '../store/agents';
import type { RosterSeat } from '../store/games';
import { agentSecretCrypto } from './agent-secret';

/** 按座位问「这一格用哪份接入身份」；不是某个玩家在答的那几问传 null，用整局的兜底那份。 */
export type SeatAccess = (seatNo: number | null) => ModelAccess;

/** 一局里逐座位的那几项。开局铺一次，整局共用。 */
export interface SeatContext {
  accessFor: SeatAccess;
  /** 这一格挂着的人设与策略，拼好的正文，按「人设 → 策略」排。没写过的格子是空数组。 */
  memoriesFor: (seatNo: number) => readonly string[];
}

/**
 * 把开局那份阵容铺成逐座位的那几项。
 *
 * 没排阵容的局整局共用兜底那份，也没有人设可拼——命令行开的局、界面上没勾 agent 开的局都是这样，
 * 这是正常跑法。排了人的格子，端点与型号取阵容里冻下的那份，密钥按 id 现读：换一把密钥接着跑得下去，
 * 换了端点就接不上了，走到这儿当场抛——拿着新端点的密钥去问老端点，问回来的是个看不懂的 401。
 *
 * @param input 环境变量、开局那份阵容、agent 存储，以及没排人的格子共用的那份
 * @returns 逐座位的取用口子
 */
export async function seatContextOf(input: {
  env: AppEnv;
  roster: readonly RosterSeat[];
  agents: AgentStore;
  fallback: ModelAccess;
}): Promise<SeatContext> {
  const { env, roster, agents, fallback } = input;
  if (roster.length === 0) return { accessFor: () => fallback, memoriesFor: () => [] };

  // 整局要的这几个人一次取回，不逐个查。
  const ids = [...new Set(roster.map((seat) => seat.agentId))];
  const [rows, memories] = await Promise.all([agents.findMany(ids), agents.memoriesMany(ids)]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const bySeat = new Map<number, { access: ModelAccess; memories: readonly string[] }>();

  for (const seat of roster) {
    const row = byId.get(seat.agentId);
    if (!row) throw new Error(`阵容里这一格排的 agent 不在了：${seat.name}`);

    bySeat.set(seat.seatNo, {
      access: accessOfSeat(env, seat, row),
      memories: memorySectionsOf(memories.get(seat.agentId) ?? EMPTY_MEMORIES),
    });
  }

  const seatOf = (seatNo: number) => {
    const seat = bySeat.get(seatNo);
    if (!seat) throw new Error(`阵容里没有 ${seatNo} 号这一格`);

    return seat;
  };

  return {
    accessFor: (seatNo) => (seatNo === null ? fallback : seatOf(seatNo).access),
    memoriesFor: (seatNo) => seatOf(seatNo).memories,
  };
}

const EMPTY_MEMORIES: AgentMemories = { persona: [], strategy: [] };

/** 这一格用哪份接入身份。端点是开局冻下的那个：对不上就是这个人中途被改过，接不上这一局。 */
function accessOfSeat(env: AppEnv, seat: RosterSeat, row: StoredAgent): ModelAccess {
  if (row.baseUrl !== seat.baseUrl) {
    throw new Error(`这一格排的 agent 改过接入端点，接不上这一局：${seat.name}`);
  }

  const baseUrl = seat.baseUrl ?? env.MODEL_BASE_URL;

  return {
    baseUrl,
    model: seat.modelName,
    // 自带密钥现读；没有就回落环境变量那一把，它非空由起跑那一头保证。
    apiKey:
      row.apiKeyCiphertext === null
        ? env.MODEL_API_KEY
        : agentSecretCrypto(env.AGENT_SECRET_KEY).decrypt(row.apiKeyCiphertext),
    capability: resolveModelCapability(seat.modelName, baseUrl, env.MODEL_CAPABILITIES),
  };
}

/** 人设与策略各摊成一段。每条标题当小标题、正文跟在后面，空的那一类不占一段。 */
function memorySectionsOf(memories: AgentMemories): readonly string[] {
  const sections = [
    sectionOf('你的人设', memories.persona),
    sectionOf('你的策略', memories.strategy),
  ];

  return sections.filter((section): section is string => section !== null);
}

function sectionOf(title: string, items: AgentMemories['persona']): string | null {
  if (items.length === 0) return null;

  return [`## ${title}`, ...items.map((item) => `### ${item.title}\n${item.body}`)].join('\n\n');
}
