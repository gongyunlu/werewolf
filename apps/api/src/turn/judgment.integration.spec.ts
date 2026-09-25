import { ACTION_TYPES, ROLES } from '@werewolf/shared';
import { randomUUID } from 'node:crypto';
import { phaseInstanceId } from '../core/identity';
import { openPrismaClient, prismaStores } from '../store/prisma';
import type { GameStores } from '../store/stores';
import { makeState, stubSkills, withRoles } from '../testing/fixtures';
import { scriptedModel } from '../testing/model';
import type { TurnOutcome } from './graph';
import { LOCAL_TURN_PROMPTS } from './prompt';
import { modelActions } from './provider';

const databaseUrl = process.env.OBSERVATION_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

function actionsFor(stores: GameStores, port: ReturnType<typeof scriptedModel>) {
  return modelActions(
    {
      port,
      accessFor: () => ({
        baseUrl: 'https://model.example.test/v1',
        model: '离线测试',
        apiKey: '用例',
        capability: { reasoningOff: null },
      }),
      memoriesFor: () => [],
      skills: stubSkills(),
      promptSource: LOCAL_TURN_PROMPTS,
    },
    stores,
  );
}

integration('Postgres 日终判断持久恢复', () => {
  it('换连接后复用已保存结果与完成检查点，下一夜实际读到本人的判断', async () => {
    const gameId = `judgment-test-${randomUUID()}`;
    let client = openPrismaClient(databaseUrl!);
    const state = withRoles(
      { ...makeState(3, false), gameId, phaseInstanceId: phaseInstanceId(5, 'dayEnd') },
      { p1: ROLES.WEREWOLF, p2: ROLES.SEER },
    );
    try {
      let stores = prismaStores(client);
      await stores.games.open({ gameId, boardId: '12p_wolf_king', roster: [] });
      await stores.events.append(gameId, {
        seq: 1,
        day: 1,
        eventKey: '边界',
        text: '本轮无人被放逐。',
        kind: 'system',
        audience: ['p1', 'p2', 'p3'],
      });
      const finish = stores.actions.finish.bind(stores.actions);
      stores.actions.finish = async (key, outcome) => {
        if ((outcome as TurnOutcome).snapshot.actorId === 'p2') throw new Error('日终结果写入中断');
        return finish(key, outcome);
      };
      const model = scriptedModel(
        Array.from({ length: 3 }, () =>
          JSON.stringify({ assessment: '暂不采信公开身份主张，继续观察。', changes: '' }),
        ),
      );
      const initial = actionsFor(stores, model);
      await initial.recordStage({ state, phaseInstanceId: state.phaseInstanceId, input: {} });
      await expect(initial.judgeDayEnd()).rejects.toThrow('日终结果写入中断');
      const before = (await stores.observations.read(gameId))!;
      expect(before.calls).toHaveLength(3);
      expect(
        (await stores.actions.list(gameId)).filter((row) => row.status === 'done'),
      ).toHaveLength(2);

      await client.$disconnect();
      client = openPrismaClient(databaseUrl!);
      stores = prismaStores(client);
      const neverCall = scriptedModel([]);
      const recovered = actionsFor(stores, neverCall);
      const anchor = (await stores.steps.last(gameId))!;
      expect(anchor.input).toEqual({ ledgerSeq: 1 });
      await recovered.recordStage(anchor);
      await recovered.judgeDayEnd();
      expect(neverCall.calls).toHaveLength(0);
      expect(
        (await stores.actions.summaries(gameId)).every(
          (row) => row.status === 'done' && row.ledgerSeq === 1,
        ),
      ).toBe(true);
      expect((await stores.observations.read(gameId))!.calls).toEqual(before.calls);

      const nextModel = scriptedModel(['3', JSON.stringify({ accept: true, issues: '' })]);
      const next = actionsFor(stores, nextModel);
      next.observe({ ...state, day: 2, phaseInstanceId: phaseInstanceId(6, 'night') });
      await next.wolfProposal('p1', ['p3']);
      const previous = next.outcomes()[0].snapshot.context.previousJudgment!;
      const source = (await stores.actions.find(previous.actionKey))!;
      expect(source).toMatchObject({
        gameId,
        actorId: 'p1',
        actionType: ACTION_TYPES.DAY_END_JUDGMENT,
        status: 'done',
      });
      expect(nextModel.calls[0].prompt).toContain('暂不采信公开身份主张');
      expect(nextModel.calls[0].prompt).toContain('不是已确认事实');
    } finally {
      await client.game.deleteMany({ where: { id: gameId } });
      await client.$disconnect();
    }
  });
});
