import type { AgentMemories } from '@werewolf/shared';

export class DuplicateAgentNameError extends Error {
  constructor(name: string) {
    super(`已经有这个名字的 agent：${name}`);
  }
}

/** 一个参赛者的接入配置。密钥那一栏是密文，解密只在真正要用它的那一处做。 */
export interface StoredAgent {
  id: string;
  name: string;
  modelName: string;
  /** 接入端点；null 表示用环境变量那一套默认接入。 */
  baseUrl: string | null;
  apiKeyCiphertext: string | null;
  /** 密钥末四位，只为在界面上认出配的是哪一把。 */
  apiKeyHint: string | null;
  tag: string | null;
  isActive: boolean;
  notes: string | null;
}

/** 新建一个 agent 要写进去的列。密钥在这一层之前已经加好密。 */
export interface AgentCreate {
  name: string;
  modelName: string;
  baseUrl: string | null;
  apiKeyCiphertext: string | null;
  apiKeyHint: string | null;
  tag: string | null;
  notes: string | null;
}

/** 改动的那些列。没列出来的不动——密钥的三态（保持 / 清掉 / 换掉）在服务那一层就折成这里的有无。 */
export type AgentPatch = Partial<
  Pick<
    StoredAgent,
    'modelName' | 'baseUrl' | 'apiKeyCiphertext' | 'apiKeyHint' | 'tag' | 'isActive' | 'notes'
  >
>;

export interface AgentStore {
  /** 全部 agent，新建在前。默认只给启用的：停用的那些开不了局。 */
  list(includeInactive: boolean): Promise<readonly StoredAgent[]>;
  find(id: string): Promise<StoredAgent | null>;
  findByName(name: string): Promise<StoredAgent | null>;
  /** 按 id 一次取回几个。开局校验走这一条，不逐个查。 */
  findMany(ids: readonly string[]): Promise<readonly StoredAgent[]>;
  create(input: AgentCreate): Promise<StoredAgent>;
  update(id: string, patch: AgentPatch): Promise<StoredAgent>;
  /** 这个人的全部人设与策略，按类分开、各自有序。 */
  memories(agentId: string): Promise<AgentMemories>;
  /**
   * 这几个人的人设与策略，按 id 一次取回——开局要一次铺齐一桌人的，不逐个查。
   * 要过的 id 一个不落，没写过的那几个给空的两类。
   */
  memoriesMany(ids: readonly string[]): Promise<ReadonlyMap<string, AgentMemories>>;
  /** 整批替换：先清空他名下的，再照交上来的顺序写进去。两件事得在一个事务里。 */
  replaceMemories(agentId: string, memories: AgentMemories): Promise<void>;
}
