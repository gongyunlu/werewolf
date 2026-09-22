import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ACTION_TYPES } from '@werewolf/shared';
import request from 'supertest';
import { actionKey, phaseInstanceId, type ActionScope } from '../core/identity';
import { AppModule } from '../app.module';
import { memoryStores } from '../store/memory';
import { GAME_STORES } from '../store/stores.provider';
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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // 应用装配带上了存储，真连库得有库在；这一条只验接口与投影，给它一份内存的。
      .overrideProvider(GAME_STORES)
      .useValue(stores)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
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
});
