import type { StageAnchor } from '../core/loop';
import { phaseInstanceId } from '../core/identity';
import { makeState } from '../testing/fixtures';
import { memoryActions, memoryEvents, memorySteps } from './memory';

/** 一条公开事实，用例里只要键和正文不同。 */
function event(seq: number, eventKey: string, text: string) {
  return { seq, eventKey, day: 1, text, kind: 'public_speech' as const, audience: ['p1', 'p2'] };
}

describe('内存事件库', () => {
  it('按局分开，记下的按顺序取回来', async () => {
    const store = memoryEvents();

    await store.append('g1', event(1, 'a', '1 号上警。'));
    await store.append('g2', event(1, 'a', '5 号上警。'));

    expect(await store.list('g1')).toEqual([event(1, 'a', '1 号上警。')]);
    expect(await store.list('g2')).toEqual([event(1, 'a', '5 号上警。')]);
  });

  it('同一个键写第二遍当场抛，跟库里那条唯一键一个意思', async () => {
    const store = memoryEvents();

    await store.append('g1', event(1, 'a', '1 号上警。'));

    await expect(store.append('g1', event(2, 'a', '1 号上警。'))).rejects.toThrow(
      '这一局的事件里已经有 a',
    );
    expect(await store.list('g1')).toHaveLength(1);
  });
});

const INTENT = {
  actionKey: '["g1","node/0/vote","vote","p2",0]',
  gameId: 'g1',
  phaseInstanceId: 'node/0/vote',
  actionType: 'vote' as const,
  actorId: 'p2',
  actionOrdinal: 0,
  ledgerSeq: 3,
};

describe('内存行动记录', () => {
  it('摘要只保留展示字段，不携带思考正文、提示词和完整上下文', async () => {
    const store = memoryActions();
    await store.begin(INTENT);
    await store.finish(INTENT.actionKey, {
      snapshot: {
        context: {
          task: '投票',
          day: 1,
          actor: { seatNo: 2, role: '平民', playerId: 'p2' },
          visible: ['长篇历史'],
        },
        decision: 'p5',
        reasoning: '长篇思考',
        prompts: ['长篇提示词'],
        thinkingMs: 123,
      },
    });
    const rows = await store.summaries('g1');
    expect(rows[0]).toMatchObject({
      hasReasoning: true,
      outcome: {
        snapshot: {
          context: { task: '投票', day: 1, actor: { seatNo: 2, role: '平民' } },
          decision: 'p5',
          thinkingMs: 123,
        },
      },
    });
    expect(JSON.stringify(rows)).not.toContain('长篇');
    expect(await store.summaries('other')).toEqual([]);
  });

  it('没立过就是空的', async () => {
    expect(await memoryActions().find(INTENT.actionKey)).toBeNull();
  });

  it('立了意图还没答完，就是 running', async () => {
    const store = memoryActions();
    await store.begin(INTENT);

    expect(await store.find(INTENT.actionKey)).toEqual({
      ...INTENT,
      status: 'running',
      outcome: null,
    });
  });

  it('答完补上结果，状态转 done', async () => {
    const store = memoryActions();
    await store.begin(INTENT);
    await store.finish(INTENT.actionKey, { decision: 'p5' });

    expect(await store.find(INTENT.actionKey)).toMatchObject({
      status: 'done',
      outcome: { decision: 'p5' },
    });
  });

  it('重走同一问再立一次意图，先立那份原样留着', async () => {
    const store = memoryActions();
    await store.begin(INTENT);
    await store.finish(INTENT.actionKey, { decision: 'p5' });
    await store.begin(INTENT);

    expect(await store.find(INTENT.actionKey)).toMatchObject({
      status: 'done',
      outcome: { decision: 'p5' },
    });
  });

  it('没立过意图就补结果是误用，当场抛', async () => {
    await expect(memoryActions().finish(INTENT.actionKey, null)).rejects.toThrow(
      '没立过意图就直接补结果',
    );
  });
});

/** 一份锚点：局面用真造一个，取回来要比得出一模一样。 */
function anchorOf(ordinal: number, nodeName: string, input: unknown): StageAnchor {
  const state = { ...makeState(6), phaseInstanceId: phaseInstanceId(ordinal, nodeName) };
  return { phaseInstanceId: state.phaseInstanceId, state, input };
}

describe('内存阶段锚点', () => {
  it('一份都没有就是 null', async () => {
    expect(await memorySteps().last('g1')).toBeNull();
  });

  it('取回来的是最后落的那一份，局面与这一格的输入原样带着', async () => {
    const store = memorySteps();
    const night = anchorOf(1, 'night', {});
    const day = anchorOf(3, 'day', { minute: 22 });

    await store.append('g1', night);
    await store.append('g1', day);

    expect(await store.last('g1')).toEqual(day);
  });

  it('同一格落第二遍不再写，先落那份留着', async () => {
    const store = memorySteps();
    const first = anchorOf(1, 'night', {});
    // 恢复重进那一格时序号不推进，落的是同一格、同一份；第二次落进来的值一律不算数。
    const again = anchorOf(1, 'night', { deaths: [{ playerId: 'p6', cause: 'night_kill' }] });

    await store.append('g1', first);
    await store.append('g1', again);

    expect(await store.last('g1')).toEqual(first);
  });

  it('按局分开', async () => {
    const store = memorySteps();
    await store.append('g1', anchorOf(1, 'night', {}));

    expect(await store.last('g2')).toBeNull();
  });

  it('几局一起问：每局认自己最后那份，没落过锚点的局不在表里', async () => {
    const store = memorySteps();
    await store.append('g1', anchorOf(1, 'night', {}));
    await store.append('g1', anchorOf(3, 'day', {}));
    await store.append('g2', anchorOf(2, 'vote', {}));

    const latest = await store.latest(['g1', 'g2', 'g3']);

    expect(latest.get('g1')?.phaseInstanceId).toBe(phaseInstanceId(3, 'day'));
    expect(latest.get('g2')?.phaseInstanceId).toBe(phaseInstanceId(2, 'vote'));
    // 没落过锚点的那局不在表里：列表页据此把它的天数与存活人数写成空。
    expect(latest.has('g3')).toBe(false);
    expect(latest.size).toBe(2);
  });

  it('一局都不问就空着回来', async () => {
    expect((await memorySteps().latest([])).size).toBe(0);
  });
});
