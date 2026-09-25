import { randomUUID } from 'node:crypto';
import { openPrismaClient, prismaStores } from '../store/prisma';
import { fakeReviewPlatform, reviewFixture } from './testing';
import { readReview, readReviewState, runReview } from './workflow';

const databaseUrl = process.env.OBSERVATION_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

integration('Postgres 复盘检查点恢复', () => {
  let client: ReturnType<typeof openPrismaClient>;
  let gameId: string;
  let actionKey: string;

  beforeEach(async () => {
    gameId = `review-test-${randomUUID()}`;
    actionKey = `${gameId}/a`;
    client = openPrismaClient(databaseUrl!);
    await reviewFixture(gameId, prismaStores(client), actionKey);
  });

  afterEach(async () => {
    await client.game.deleteMany({ where: { id: gameId } });
    await client.$disconnect();
  });

  async function reconnect() {
    await client.$disconnect();
    client = openPrismaClient(databaseUrl!);
    return prismaStores(client);
  }

  it('跨连接恢复已送达但响应丢失的提交，保留已接受结果与冻结证据', async () => {
    let stores = prismaStores(client);
    const { platform, inputs } = fakeReviewPlatform();
    const submit = platform.submit.getMockImplementation()!;
    platform.submit.mockImplementation(async (unit) => {
      expect((await readReviewState(stores, gameId))!.pending).toEqual(unit);
      await submit(unit);
      if (unit.step === 'review_player') throw new Error('响应丢失');
    });
    await expect(runReview(stores, gameId, platform)).rejects.toThrow('响应丢失');
    const before = (await readReviewState(stores, gameId))!;
    expect(before.receipts.map((receipt) => receipt.key)).toEqual([`decision/${actionKey}`]);
    expect(before.pending).toEqual(inputs.get('player/p1'));

    stores = await reconnect();
    expect(await readReviewState(stores, gameId)).toEqual(before);
    await stores.events.append(gameId, {
      seq: 2,
      eventKey: 'late',
      day: 2,
      kind: 'system',
      text: '冻结后追加的内容',
      audience: ['p1'],
    });
    platform.submit.mockImplementation(submit);
    const report = (await runReview(stores, gameId, platform))!;
    expect(report.completedAt).not.toBeNull();
    expect(report.evidence).toEqual(before.evidence);
    expect(report.players[0]!.evaluatedDecisions).toBe(1);
    expect(platform.exists).toHaveBeenCalledWith(before.pending);
    expect(platform.submit.mock.calls.map(([unit]) => unit.key)).toEqual([
      `decision/${actionKey}`,
      'player/p1',
      'outcome',
    ]);

    stores = await reconnect();
    platform.wait.mockClear();
    expect(await readReview(stores, gameId, platform)).toEqual(report);
    expect(await runReview(stores, gameId, platform)).toEqual(report);
    expect(platform.submit).toHaveBeenCalledTimes(3);
    expect(platform.wait).not.toHaveBeenCalled();
    expect((await stores.observations.read(gameId))!.calls).toHaveLength(0);
  });

  it('跨连接恢复未知提交仍不重投，部分读取不把待处理项计为已评价', async () => {
    const { platform } = fakeReviewPlatform();
    platform.submit.mockRejectedValueOnce(new Error('连接断开'));
    await expect(runReview(prismaStores(client), gameId, platform)).rejects.toThrow('连接断开');

    const stores = await reconnect();
    const partial = (await readReview(stores, gameId, platform))!;
    expect(partial.completedAt).toBeNull();
    expect(partial.players[0]!.evaluatedDecisions).toBe(0);
    expect(partial.units).toHaveLength(1);
    expect(partial.units[0]!.result).toBeNull();
    await expect(runReview(stores, gameId, platform)).rejects.toThrow('提交状态未知');
    expect(platform.submit).toHaveBeenCalledTimes(1);
    expect(platform.wait).not.toHaveBeenCalled();
  });
});
