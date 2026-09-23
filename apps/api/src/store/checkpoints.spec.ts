import { END, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { ACTION_TYPES } from '@werewolf/shared';
import { z } from 'zod';
import { phaseInstanceId, type ActionScope } from '../core/identity';
import type { ModelAccess } from '../llm/model-port';
import { stubSkills } from '../testing/fixtures';
import { scriptedModel } from '../testing/model';
import { runActionGraph } from '../turn/graph';
import { LOCAL_TURN_PROMPTS } from '../turn/prompt';
import { actionKeyOf, type ActionRequest, type TurnContext } from '../turn/request';
import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { prismaCheckpoints } from './checkpoints';

type Row = Record<string, unknown>;

const ACCESS: ModelAccess = {
  baseUrl: 'https://model.example.test/v1',
  model: '用例模型',
  apiKey: 'sk-用例',
  capability: { reasoningOff: null },
};

const SCOPE: ActionScope = { gameId: 'g1', phaseInstanceId: phaseInstanceId(3, 'vote') };

const CONTEXT: TurnContext = {
  task: '投票决定放逐谁。',
  actor: { playerId: 'p3', seatNo: 3, role: '预言家' },
  day: 2,
  visible: [{ title: '局面', lines: ['1 号昨天跳了预言家'] }],
  options: ['1 号 p1', '2 号 p2'],
  skill: [],
};

const DECIDED = JSON.stringify({ targetId: 'p2', reason: '他发言太稳了' });
const ACCEPTED = JSON.stringify({ accept: true, issues: '' });

/** 模型交回来的原话：走工具那一问的参数裹着壳（见 decisions 的 toolOf），脚本里写的是壳里那个值。 */
const wrapped = (answer: string): string => `{"value":${answer}}`;

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    scope: SCOPE,
    actionType: ACTION_TYPES.VOTE,
    actorId: 'p3',
    actionOrdinal: 0,
    preset: 'quality',
    context: CONTEXT,
    schema: z.object({ targetId: z.string().nullable(), reason: z.string() }),
    ...overrides,
  };
}

function withModel(answers: readonly (string | Error)[]) {
  const model = scriptedModel(answers);
  return {
    model,
    runtime: {
      port: model,
      accessFor: () => ACCESS,
      memoriesFor: () => [],
      promptSource: LOCAL_TURN_PROMPTS,
      skills: stubSkills(),
    },
  };
}

/**
 * 假的对局库。只认这张 saver 递过来的那几种 where，别的形状解不出来。
 * 存的是递进来的原值：真库那一列非空，哨兵落成 JSON 的 null，递裸 null 进去当场失败——
 * 用例要看的正是「递进来的是哨兵还是裸 null」，所以收的时候不动它，读的时候才按库那套翻回来。
 */
class FakeClient {
  readonly checkpoints: Row[] = [];
  readonly writes: Row[] = [];
  failChannel: string | null = null;
  unavailable = false;

  async $transaction<T>(run: (client: FakeClient) => Promise<T>): Promise<T> {
    const checkpoints = this.checkpoints.map((row) => ({ ...row }));
    const writes = this.writes.map((row) => ({ ...row }));
    try {
      return await run(this);
    } catch (error) {
      this.checkpoints.splice(0, this.checkpoints.length, ...checkpoints);
      this.writes.splice(0, this.writes.length, ...writes);
      throw error;
    }
  }

  /** 主键那几条写在 where 里：`{a: 1}` 与 `{主键: {a: 1}}` 两种写法都要认。 */
  private static hits(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'AND') return (value as Row[]).every((part) => FakeClient.hits(row, part));
      if (key === 'metadata') {
        const filter = value as { path: string[]; equals: unknown };
        return (row.metadata as Row)[filter.path[0]] === filter.equals;
      }
      if (key === 'checkpointId' && typeof value === 'object' && value !== null) {
        const filter = value as { lt?: string; in?: string[] };
        return filter.lt ? String(row[key]) < filter.lt : filter.in!.includes(String(row[key]));
      }
      return typeof value === 'object' && value !== null
        ? Object.entries(value as Row).every(([field, part]) => row[field] === part)
        : row[key] === value;
    });
  }

  readonly graphCheckpoint = {
    findUnique: async ({ where }: { where: Row }) =>
      this.checkpoints.find((row) => FakeClient.hits(row, where)),
    findFirst: async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
      const found = this.checkpoints.filter((row) => FakeClient.hits(row, where));
      if (orderBy?.checkpointId === 'desc') {
        return found.toSorted((a, b) =>
          String(b.checkpointId).localeCompare(String(a.checkpointId)),
        )[0];
      }
      return found[0];
    },
    findMany: jest.fn(async ({ where, take }: { where: Row; take?: number }) =>
      this.checkpoints
        .filter((row) => FakeClient.hits(row, where))
        .toSorted((a, b) => String(b.checkpointId).localeCompare(String(a.checkpointId)))
        .slice(0, take),
    ),
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      if (this.unavailable) throw new Error('数据库暂时不可用');
      const found = this.checkpoints.find((row) => FakeClient.hits(row, where));
      if (found) Object.assign(found, update);
      else this.checkpoints.push({ ...create, createdAt: this.checkpoints.length });
    },
    deleteMany: async ({ where }: { where: Row }) => {
      for (const row of this.checkpoints.filter((item) => FakeClient.hits(item, where))) {
        this.checkpoints.splice(this.checkpoints.indexOf(row), 1);
      }
    },
  };

  readonly graphCheckpointWrite = {
    findMany: jest.fn(async ({ where }: { where: Row }) =>
      this.writes
        .filter((row) => FakeClient.hits(row, where))
        .toSorted(
          (left, right) =>
            String(left.taskId).localeCompare(String(right.taskId)) ||
            Number(left.idx) - Number(right.idx),
        )
        // 读到的是 JSON 的 null：哨兵是递出去时那一侧的说法，库里存的还是 null。
        .map((row) => ({ ...row, value: row.value === Prisma.JsonNull ? null : row.value })),
    ),
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      if (create.channel === this.failChannel) this.unavailable = true;
      if (this.unavailable) throw new Error('数据库暂时不可用');
      const found = this.writes.find((row) => FakeClient.hits(row, where));
      if (found) Object.assign(found, update);
      else this.writes.push(create);
    },
    deleteMany: async ({ where }: { where: Row }) => {
      for (const row of this.writes.filter((item) => FakeClient.hits(item, where))) {
        this.writes.splice(this.writes.indexOf(row), 1);
      }
    },
  };
}

/** 库那边只用到上面那几下，用例递一份假的进去。 */
function saverOn(client: FakeClient) {
  return prismaCheckpoints(client as unknown as PrismaClient);
}

describe('行动图的进度落在对局库里', () => {
  it('查询历史在库内过滤和限量，并批量读取分支结果', async () => {
    const client = new FakeClient();
    const saver = saverOn(client);
    const config = { configurable: { thread_id: actionKeyOf(request()) } };
    for (const id of ['1', '2', '3', '4']) {
      const saved = await saver.put(
        config,
        {
          v: 4,
          id,
          ts: '2026-09-23T00:00:00Z',
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        },
        { source: id === '3' ? 'input' : 'loop', step: Number(id), parents: {} },
        {},
      );
      await saver.putWrites(saved, [['value', id]], 'task');
    }
    const rows = [];
    for await (const row of saver.list(config, {
      before: { configurable: { checkpoint_id: '4' } },
      filter: { source: 'loop' },
      limit: 2,
    }))
      rows.push(row);
    expect(rows.map((row) => row.checkpoint.id)).toEqual(['2', '1']);
    expect(rows.map((row) => row.pendingWrites)).toEqual([
      [['task', 'value', '2']],
      [['task', 'value', '1']],
    ]);
    expect(client.graphCheckpoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        orderBy: { checkpointId: 'desc' },
        where: expect.objectContaining({
          AND: [{ metadata: { path: ['source'], equals: 'loop' } }],
        }),
      }),
    );
    expect(client.graphCheckpointWrite.findMany).toHaveBeenCalledTimes(1);
    expect((await saver.getTuple(config))?.checkpoint.id).toBe('4');
  });

  it('节点结果写到一半失败时整批回滚，恢复后重新执行节点', async () => {
    const client = new FakeClient();
    client.failChannel = 'y';
    const produce = jest.fn(() => ({ x: 1, y: 2 }));
    const graph = new StateGraph(
      new StateSchema({ x: z.number().default(0), y: z.number().default(0) }),
    )
      .addNode('produce', produce)
      .addEdge(START, 'produce')
      .addEdge('produce', END)
      .compile({ checkpointer: saverOn(client) });
    const config = {
      configurable: { thread_id: actionKeyOf(request()) },
      durability: 'sync' as const,
    };

    await expect(graph.invoke({}, config)).rejects.toThrow('数据库暂时不可用');
    expect(client.writes.some((row) => row.channel === 'x')).toBe(false);

    client.failChannel = null;
    client.unavailable = false;
    await expect(graph.invoke(null, config)).resolves.toMatchObject({ x: 1, y: 2 });
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('一次行动跑完，检查点与写入都落在行动键那条线程下、这一局名下', async () => {
    const client = new FakeClient();
    const ask = request();

    await runActionGraph(withModel([DECIDED, ACCEPTED]).runtime, ask, {
      saver: saverOn(client),
    });

    expect(client.checkpoints.length).toBeGreaterThan(1);
    expect(client.writes.length).toBeGreaterThan(0);
    // 库里认这一局靠的是线程键第一段解出来的 id：解错了，这一局的进度就落到别的局名下。
    expect(client.checkpoints.every((row) => row.gameId === SCOPE.gameId)).toBe(true);
    expect(client.checkpoints.every((row) => row.checkpointNs === actionKeyOf(ask))).toBe(true);
    expect(client.writes.every((row) => row.checkpointNs === actionKeyOf(ask))).toBe(true);
    // 父检查点串成一条链，接着跑要顺着它往回取。
    expect(client.checkpoints.some((row) => row.parentCheckpointId !== null)).toBe(true);
  });

  it('框架给静态边写的 null 换成哨兵：非空列收不下裸 null', async () => {
    const client = new FakeClient();

    await runActionGraph(withModel([DECIDED, ACCEPTED]).runtime, request(), {
      saver: saverOn(client),
    });

    // 框架每条静态边都写一个「这条边上没写东西」，库那边那一列非空。
    expect(client.writes.filter((row) => row.value === Prisma.JsonNull).length).toBeGreaterThan(0);
    expect(client.writes.some((row) => row.value === null)).toBe(false);
  });

  it('断在半路，拿库里的进度接着跑：从断点往下走，前面问过的不再问', async () => {
    const client = new FakeClient();
    const saver = saverOn(client);
    const ask = request();
    await expect(
      runActionGraph(withModel([DECIDED, new Error('这一跑断在这儿')]).runtime, ask, {
        saver,
      }),
    ).rejects.toThrow('这一跑断在这儿');

    // 换一份脚本接着跑：不认断点的话它会拿着新脚本从头问起，第一格就露馅。
    const resumed = withModel([ACCEPTED]);
    const outcome = await runActionGraph(resumed.runtime, ask, { saver, resume: true });

    expect(resumed.model.calls).toHaveLength(1);
    // 草稿来自断点里那一份，不是这一跑重新问出来的。
    expect(outcome.snapshot.draft).toBe(wrapped(DECIDED));
  });

  it('线程不是行动键就当场抛，不拿它当某一局的进度', async () => {
    const saver = saverOn(new FakeClient());
    const checkpoint = {
      v: 1,
      id: '1',
      ts: '2026-01-01T00:00:00Z',
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };
    // 这几条都在认线程名那一步就抛了，元数据递不进去，随便给一份形状对的。
    const metadata = { source: 'input' as const, step: 1, parents: {} };

    // 裸的对局 id、一段 JSON、一个对象：都解不出「第一段是对局标识」，不能悄悄当某一局的进度收下。
    for (const threadId of ['g1', '"别的局"', '{"gameId":"g1"}']) {
      await expect(
        saver.put({ configurable: { thread_id: threadId } }, checkpoint, metadata, {}),
      ).rejects.toThrow('检查点这条线程不是行动键');
    }
    await expect(saver.put({ configurable: {} }, checkpoint, metadata, {})).rejects.toThrow(
      '检查点缺少线程标识',
    );
    await expect(
      saver.putWrites({ configurable: { thread_id: actionKeyOf(request()) } }, [['a', 1]], 'task'),
    ).rejects.toThrow('写入分支结果要指出当前是哪一份检查点');
  });
});
