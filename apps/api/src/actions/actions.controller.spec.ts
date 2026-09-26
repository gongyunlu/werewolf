import { INestApplication } from '@nestjs/common';
import { ACTION_TYPES } from '@werewolf/shared';
import request from 'supertest';
import { actionKey, phaseInstanceId, type ActionScope } from '../core/identity';
import { testAppModule } from '../testing/app';
import { memoryStores } from '../store/memory';
import type { GameStores } from '../store/stores';

/**
 * 一份够用的快照：这一层只读得着 context 那几项、决定与推理，别处写了也读不着。
 * 决定存的是 toCore 之前那份，也就是模型交上来的座位号。
 */
function snapshotOf(fields: {
  day: number;
  seatNo: number;
  role: string;
  task: string;
  decision: unknown;
  reasoning?: string | null;
}) {
  return {
    context: {
      task: fields.task,
      actor: { playerId: `p${fields.seatNo}`, seatNo: fields.seatNo, role: fields.role },
      day: fields.day,
    },
    decision: fields.decision,
    ...(fields.reasoning === undefined ? {} : { reasoning: fields.reasoning }),
  };
}

/** 立一行记录；给了快照才算答完，没给的那一行还停在 running。 */
async function record(
  stores: GameStores,
  gameId: string,
  ordinal: number,
  snapshot?: ReturnType<typeof snapshotOf>,
) {
  const scope: ActionScope = { gameId, phaseInstanceId: phaseInstanceId(3, 'vote') };
  const key = actionKey(scope, ACTION_TYPES.VOTE, 'p3', ordinal);

  await stores.actions.begin({
    actionKey: key,
    gameId,
    phaseInstanceId: scope.phaseInstanceId,
    actionType: ACTION_TYPES.VOTE,
    actorId: 'p3',
    actionOrdinal: ordinal,
    ledgerSeq: 0,
  });
  if (snapshot !== undefined) {
    // 落库的那份决定与快照里那份一样，都是 toCore 之前的座位号：换回玩家标识是问完之后的事。
    await stores.actions.finish(key, { decision: snapshot.decision, snapshot });
  }
}

describe('行动记录只读接口', () => {
  let app: INestApplication;
  let stores: GameStores;

  beforeAll(async () => {
    stores = memoryStores();
    const moduleRef = await testAppModule(stores).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('行动检索详情只返回保存的查询和结果，不传原始向量或读取当前经验池', async () => {
    const retrieval = {
      status: 'completed' as const,
      query: '当时可见的信息',
      model: '向量模型',
      failure: null,
      candidates: [],
      selected: [],
      scope: { gameId: 'g-retrieval', role: 'guard', boardId: '6p_white_wolf' },
      embedding: {
        text: '当时可见的信息',
        key: 'key',
        model: '向量模型',
        dimensions: 2,
        attempts: [{ callId: 'v1', status: 'responded' as const, vector: [1, 0] }],
      },
    };
    await stores.actions.begin({
      actionKey: 'retrieval-key',
      gameId: 'g-retrieval',
      phaseInstanceId: phaseInstanceId(1, 'night'),
      actionType: 'guard_protect',
      actorId: 'p1',
      actionOrdinal: 0,
      ledgerSeq: 0,
      experienceRetrieval: retrieval,
    });
    const search = jest.spyOn(stores.experiences, 'search');
    const { body } = await request(app.getHttpServer())
      .get('/api/games/g-retrieval/actions/detail')
      .query({ actionKey: 'retrieval-key' })
      .expect(200);
    expect(body.experienceRetrieval).toEqual({
      status: 'completed',
      query: retrieval.query,
      model: retrieval.model,
      failure: null,
      candidates: [],
      selected: [],
    });
    expect(search).not.toHaveBeenCalled();
    search.mockRestore();
  });

  it('按问的先后出答完的那些，没答完的不进列表', async () => {
    const asked = (seatNo: number) =>
      snapshotOf({ day: 2, seatNo, role: '预言家', task: '投票决定放逐谁。', decision: seatNo });
    await record(stores, 'g-done', 0, asked(5));
    await record(stores, 'g-done', 1);
    await record(stores, 'g-done', 2, asked(9));

    const { body } = await request(app.getHttpServer())
      .get('/api/games/g-done/actions')
      .expect(200);

    // 中间那条还没答完，没有结果可看：重走到那一问会整个重跑一遍。
    expect(body.actions.map((entry: { decision: number }) => entry.decision)).toEqual([5, 9]);
  });

  it('进列表的那一片取的是快照里那几项，决定是 toCore 之前那份座位号', async () => {
    await record(
      stores,
      'g-one',
      0,
      snapshotOf({
        day: 2,
        seatNo: 3,
        role: '预言家',
        task: '投票决定放逐谁。',
        decision: 5,
        reasoning: '他发言太稳，先投他',
      }),
    );

    const { body } = await request(app.getHttpServer()).get('/api/games/g-one/actions').expect(200);

    expect(body.actions).toEqual([
      {
        actionKey: actionKey(
          { gameId: 'g-one', phaseInstanceId: phaseInstanceId(3, 'vote') },
          ACTION_TYPES.VOTE,
          'p3',
          0,
        ),
        actionType: ACTION_TYPES.VOTE,
        day: 2,
        seatNo: 3,
        role: '预言家',
        task: '投票决定放逐谁。',
        decision: 5,
        reasoning: '他发言太稳，先投他',
      },
    ]);
  });

  it('这一项还没有的那些记录，读出来是 null', async () => {
    await record(
      stores,
      'g-old',
      0,
      snapshotOf({ day: 1, seatNo: 3, role: '预言家', task: '投票决定放逐谁。', decision: 2 }),
    );

    const { body } = await request(app.getHttpServer()).get('/api/games/g-old/actions').expect(200);

    expect(body.actions[0].reasoning).toBeNull();
  });

  it('这一局一条都没有就是空数组', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/api/games/g-none/actions')
      .expect(200);

    expect(body.actions).toEqual([]);
  });

  it('过程列表不包含长篇思考，展开后才返回，旧存档也可以回看', async () => {
    const gameId = 'g-history';
    await record(
      stores,
      gameId,
      0,
      snapshotOf({
        day: 2,
        seatNo: 3,
        role: '预言家',
        task: '投票',
        decision: 5,
        reasoning: '保留下来的推理',
      }),
    );
    const key = actionKey(
      { gameId, phaseInstanceId: phaseInstanceId(3, 'vote') },
      ACTION_TYPES.VOTE,
      'p3',
      0,
    );
    await stores.events.append(gameId, {
      seq: 1,
      eventKey: key,
      day: 2,
      kind: 'ballot',
      text: '投票结果',
      audience: ['p3'],
    });
    const fullActions = jest.spyOn(stores.actions, 'list');
    const fullEvents = jest.spyOn(stores.events, 'list');
    const { body: summary } = await request(app.getHttpServer())
      .get(`/api/games/${gameId}/actions/summaries`)
      .expect(200);
    expect(fullActions).not.toHaveBeenCalled();
    expect(fullEvents).not.toHaveBeenCalled();
    fullActions.mockRestore();
    fullEvents.mockRestore();
    expect(summary.actions[0]).toMatchObject({ hasReasoning: true, ledgerSeq: 0 });
    expect(summary.actions[0]).toMatchObject({ phase: 'vote', eventSeq: 1 });
    expect(summary.actions[0]).not.toHaveProperty('reasoning');
    const { body: detail } = await request(app.getHttpServer())
      .get(`/api/games/${gameId}/actions/detail`)
      .query({ actionKey: summary.actions[0].actionKey })
      .expect(200);
    expect(detail).toEqual({
      reasoning: '保留下来的推理',
      steps: [],
      experienceInputs: [],
      knowledgeInputs: [],
    });
    await request(app.getHttpServer())
      .get('/api/games/other/actions/detail')
      .query({ actionKey: summary.actions[0].actionKey })
      .expect(404);
  });

  it('未完成的行动也提供入口，刷新后仍能查到已保存的节点', async () => {
    await record(stores, 'g-pending', 0);
    const { body } = await request(app.getHttpServer())
      .get('/api/games/g-pending/actions/summaries')
      .expect(200);
    expect(body.actions).toEqual([]);
    expect(body.pending).toEqual([
      {
        actionKey: actionKey(
          { gameId: 'g-pending', phaseInstanceId: phaseInstanceId(3, 'vote') },
          ACTION_TYPES.VOTE,
          'p3',
          0,
        ),
        actorId: 'p3',
        actionType: ACTION_TYPES.VOTE,
        ledgerSeq: 0,
        phase: 'vote',
      },
    ]);
    const { body: detail } = await request(app.getHttpServer())
      .get('/api/games/g-pending/actions/detail')
      .query({ actionKey: body.pending[0].actionKey })
      .expect(200);
    expect(detail).toEqual({
      reasoning: null,
      steps: [],
      experienceInputs: [],
      knowledgeInputs: [],
    });
  });
});
