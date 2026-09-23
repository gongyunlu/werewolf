import {
  BaseCheckpointSaver,
  copyCheckpoint,
  WRITES_IDX_MAP,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import { Prisma, PrismaClient } from '../generated/prisma/client';

/** 运行配置里这一层要用的口子。框架的配置比这宽得多，这里只认这几项。 */
interface CheckpointConfig {
  configurable?: Record<string, unknown>;
}

interface Located {
  gameId: string;
  /** 一次行动一条线：线程键就是行动键，也按它归档这一局的进度。 */
  checkpointNs: string;
  checkpointId?: string;
}

interface LocatedAt extends Located {
  checkpointId: string;
}

/**
 * 用对局库保存行动图的执行进度。
 *
 * 一次行动一条线程：同一局的不同行动各自持有自己的进度，谁也不会接着谁的半截状态往下跑。
 * 哪一局由线程键认出来（它就是行动键，见 gameIdOf），不额外走运行配置——配置在框架内部
 * 会被倒几手，多带一样东西就多一样能被弄丢的东西。
 * 读取不做归属校验——进度属于执行本身，谁能读由调用方决定。
 * 序列化交给基类的 serde，不自行维护编码格式。
 */
export function prismaCheckpoints(client: PrismaClient): BaseCheckpointSaver {
  return new PrismaCheckpointSaver(client);
}

class PrismaCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly client: PrismaClient) {
    super();
  }

  async getTuple(config: CheckpointConfig): Promise<CheckpointTuple | undefined> {
    const { gameId, checkpointNs, checkpointId } = this.locate(config);
    const row = checkpointId
      ? await this.client.graphCheckpoint.findUnique({
          where: { gameId_checkpointNs_checkpointId: { gameId, checkpointNs, checkpointId } },
        })
      : await this.client.graphCheckpoint.findFirst({
          where: { gameId, checkpointNs },
          // LangGraph 的检查点 ID 按时间递增，与翻页游标保持同一顺序。
          orderBy: { checkpointId: 'desc' },
        });

    return row ? this.toTuple(row) : undefined;
  }

  async *list(
    config: CheckpointConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { gameId, checkpointNs } = this.locate(config);
    if (options?.limit === 0) return;
    const rows = await this.client.graphCheckpoint.findMany({
      where: {
        gameId,
        checkpointNs,
        AND: Object.entries(options?.filter ?? {}).map(([key, value]) => ({
          metadata: {
            path: [key],
            equals: value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue),
          },
        })),
        ...(options?.before?.configurable?.checkpoint_id
          ? { checkpointId: { lt: options.before.configurable.checkpoint_id as string } }
          : {}),
      },
      orderBy: { checkpointId: 'desc' },
      take: options?.limit,
    });
    if (rows.length === 0) return;
    const writes = await this.client.graphCheckpointWrite.findMany({
      where: { gameId, checkpointNs, checkpointId: { in: rows.map((row) => row.checkpointId) } },
      orderBy: [{ taskId: 'asc' }, { idx: 'asc' }],
    });
    const byCheckpoint = new Map<string, Prisma.GraphCheckpointWriteModel[]>();
    for (const write of writes) {
      const group = byCheckpoint.get(write.checkpointId) ?? [];
      group.push(write);
      byCheckpoint.set(write.checkpointId, group);
    }
    for (const row of rows) {
      yield await this.toTuple(row, byCheckpoint.get(row.checkpointId) ?? []);
    }
  }

  async put(
    config: CheckpointConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<{ configurable: Record<string, unknown> }> {
    const { gameId, checkpointNs, checkpointId } = this.locate(config);
    const prepared = copyCheckpoint(checkpoint);
    // 检查点与元数据都是图自己拼的对象，不会是 JSON 的 null，这里认回它的类型。
    const data = {
      checkpoint: (await this.encode(prepared)) as Prisma.InputJsonValue,
      metadata: (await this.encode(metadata)) as Prisma.InputJsonValue,
    };

    await this.client.graphCheckpoint.upsert({
      where: {
        gameId_checkpointNs_checkpointId: { gameId, checkpointNs, checkpointId: prepared.id },
      },
      create: {
        gameId,
        checkpointNs,
        checkpointId: prepared.id,
        parentCheckpointId: checkpointId ?? null,
        ...data,
      },
      update: data,
    });

    // 交出去的这份配置后面还会被递回来；线程键在，这一局的归属就在。
    return { configurable: { thread_id: checkpointNs, checkpoint_id: prepared.id } };
  }

  async putWrites(config: CheckpointConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const located = this.locateAt(config);
    const encoded = await Promise.all(
      writes.map(async ([channel, value], position) => ({
        // 框架内部那几条通道用负下标，跟常规写入的位置下标分开，见 WRITES_IDX_MAP。
        idx: WRITES_IDX_MAP[channel] ?? position,
        channel,
        value: await this.encode(value),
      })),
    );

    await this.client.$transaction(async (client) => {
      for (const write of encoded) {
        const key = {
          gameId: located.gameId,
          checkpointNs: located.checkpointNs,
          checkpointId: located.checkpointId,
          taskId,
          idx: write.idx,
        };
        const data = {
          channel: write.channel,
          // 框架给每条静态边都写一个 null（「这条边上没写东西」），库里这一列非空，落成 JSON 的 null。
          value: write.value === null ? Prisma.JsonNull : write.value,
        };
        await client.graphCheckpointWrite.upsert({
          where: { gameId_checkpointNs_checkpointId_taskId_idx: key },
          create: { ...key, ...data },
          // 常规写入按位置幂等，先落那份留着；内部通道允许覆盖，与基类语义一致。
          update: write.idx < 0 ? data : {},
        });
      }
    });
  }

  /** 线程键就是行动键，本身已经锁到某一局，不必再按对局筛一遍。 */
  async deleteThread(threadId: string): Promise<void> {
    await this.client.$transaction(async (client) => {
      await client.graphCheckpointWrite.deleteMany({ where: { checkpointNs: threadId } });
      await client.graphCheckpoint.deleteMany({ where: { checkpointNs: threadId } });
    });
  }

  private async toTuple(
    row: Prisma.GraphCheckpointModel,
    pending?: readonly Prisma.GraphCheckpointWriteModel[],
  ): Promise<CheckpointTuple> {
    const writes =
      pending ??
      (await this.client.graphCheckpointWrite.findMany({
        where: {
          gameId: row.gameId,
          checkpointNs: row.checkpointNs,
          checkpointId: row.checkpointId,
        },
        orderBy: [{ taskId: 'asc' }, { idx: 'asc' }],
      }));
    const pendingWrites = await Promise.all(
      writes.map(
        async (write) =>
          [write.taskId, write.channel, await this.decode(write.value)] as CheckpointPendingWrite,
      ),
    );

    const configurable = {
      thread_id: row.checkpointNs,
      checkpoint_ns: '',
      checkpoint_id: row.checkpointId,
    };

    return {
      config: { configurable },
      checkpoint: (await this.decode(row.checkpoint)) as Checkpoint,
      metadata: (await this.decode(row.metadata)) as CheckpointMetadata,
      pendingWrites,
      ...(row.parentCheckpointId
        ? {
            parentConfig: {
              configurable: { ...configurable, checkpoint_id: row.parentCheckpointId },
            },
          }
        : {}),
    };
  }

  /** 这一次落哪一行：对局、这条线程，以及指定的那一份检查点。 */
  private locate(config: CheckpointConfig): Located {
    const configurable = config.configurable ?? {};
    const checkpointId = configurable.checkpoint_id;

    const checkpointNs = this.threadOf(config);

    return {
      gameId: this.gameIdOf(checkpointNs),
      checkpointNs,
      ...(typeof checkpointId === 'string' ? { checkpointId } : {}),
    };
  }

  private locateAt(config: CheckpointConfig): LocatedAt {
    const located = this.locate(config);
    if (!located.checkpointId) throw new Error('写入分支结果要指出当前是哪一份检查点');
    return { ...located, checkpointId: located.checkpointId };
  }

  /**
   * 线程键就是行动键，第一段是这一局的 id：行动图那边按行动键开线程，这里按它归档。
   * 解不出第一段说明这条线程不是行动图开的，拿它当进度会落到别的局上。
   */
  private gameIdOf(threadId: string): string {
    // 裸的对局 id 是传得错的那种：解不出 JSON 就跟解出的形状不对一样，都归到同一句话上。
    const key: unknown = parseOrNull(threadId);
    const gameId = Array.isArray(key) ? (key[0] as unknown) : undefined;
    if (typeof gameId !== 'string') throw new Error(`检查点这条线程不是行动键：${threadId}`);
    return gameId;
  }

  private threadOf(config: CheckpointConfig): string {
    const threadId = config.configurable?.thread_id;
    if (typeof threadId !== 'string' || !threadId) throw new Error('检查点缺少线程标识');
    return threadId;
  }

  /** 存进去的是 JSON 值；出现别的类型说明图状态里混了存不回来的东西，当场炸。 */
  private async encode(value: unknown): Promise<Prisma.InputJsonValue | null> {
    const [type, payload] = await this.serde.dumpsTyped(value);
    if (type !== 'json') throw new Error(`图执行进度里出现 ${type} 类型，库里只承载 JSON 值`);
    return JSON.parse(new TextDecoder().decode(payload)) as Prisma.InputJsonValue | null;
  }

  private decode(value: Prisma.JsonValue): Promise<unknown> {
    return this.serde.loadsTyped('json', JSON.stringify(value));
  }
}

/** 解不出 JSON 就是没解出：是不是行动键由调用方按形状统一判，这里不另报一句。 */
function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
