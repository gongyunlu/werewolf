import type { GameEvent } from '@werewolf/shared';
import type { Redis } from 'ioredis';
import { GameEventHub } from '../queue/game-event-hub';
import { EVENT_KINDS, type StoredEvent } from '../store/events';
import { memoryEvents } from '../store/memory';
import { FakeRedis, take } from '../testing/stream';
import { gameEvents, type Streamed } from './events-stream';

function event(seq: number, text = `第 ${seq} 条`): StoredEvent {
  return { seq, eventKey: `k${seq}`, day: 1, text, kind: EVENT_KINDS.OTHER, audience: ['p1'] };
}

/** 收到的这几条里的序号；预览那一支没有序号，挑掉。 */
function seqs(rows: readonly Streamed[]): number[] {
  return rows.flatMap((row) => ('event' in row ? [row.event.seq] : []));
}

/** 频道上那条：台账行的幂等键不上频道。 */
function wire(seq: number): unknown {
  return { gameId: 'g1', event: { ...event(seq), eventKey: undefined } };
}

/** 中转连着它的两条假连接；用例往 sub 上抛就等于 Redis 推过来。 */
function hubOn(pub: FakeRedis, sub: FakeRedis): GameEventHub {
  return new GameEventHub(pub as unknown as Redis, sub as unknown as Redis);
}

describe('观战的事件流', () => {
  it('实时事件出现缺口时先补齐数据库记录，重连游标只推进到连续位置', async () => {
    const sub = new FakeRedis();
    const events = memoryEvents();
    await events.append('g1', event(1));
    const hub = hubOn(new FakeRedis(), sub);
    const seen: Streamed[] = [];
    const subscription = gameEvents({ events, hub, gameId: 'g1', after: 0 }).subscribe((row) =>
      seen.push(row),
    );
    await new Promise(setImmediate);
    await events.append('g1', event(2));
    await events.append('g1', event(3));
    sub.deliver(wire(3));
    await new Promise(setImmediate);
    subscription.unsubscribe();
    expect(seqs(seen)).toEqual([1, 2, 3]);
  });

  it('Redis 重新订阅后即使没有新消息，也补读断线期间的事实', async () => {
    const sub = new FakeRedis();
    const events = memoryEvents();
    await events.append('g1', event(1));
    const hub = hubOn(new FakeRedis(), sub);
    const seen: Streamed[] = [];
    const subscription = gameEvents({ events, hub, gameId: 'g1', after: 0 }).subscribe((row) =>
      seen.push(row),
    );
    await new Promise(setImmediate);
    await events.append('g1', event(2));
    sub.emit('ready');
    await new Promise(setImmediate);
    subscription.unsubscribe();
    expect(seqs(seen)).toEqual([1, 2]);
  });

  it('数据库尚未补齐时不跳过缺口，乱序到达后连续发出且不重复', async () => {
    const sub = new FakeRedis();
    const hub = hubOn(new FakeRedis(), sub);
    const seen: Streamed[] = [];
    const subscription = gameEvents({
      events: memoryEvents(),
      hub,
      gameId: 'g1',
      after: 0,
    }).subscribe((row) => seen.push(row));
    sub.deliver(wire(1));
    sub.deliver(wire(3));
    await new Promise(setImmediate);
    expect(seqs(seen)).toEqual([1]);
    sub.deliver(wire(2));
    sub.deliver(wire(3));
    await new Promise(setImmediate);
    subscription.unsubscribe();
    expect(seqs(seen)).toEqual([1, 2, 3]);
  });

  it('先把台账里积压的按序补上，再接实时的', async () => {
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const events = memoryEvents();
    await events.append('g1', event(1));
    await events.append('g1', event(2));
    const hub = hubOn(pub, sub);

    const collected = take(gameEvents({ events, hub, gameId: 'g1', after: 0 }), 3);
    sub.deliver(wire(3));

    expect(seqs(await collected)).toEqual([1, 2, 3]);
  });

  it('看过的那些不再发：从报回来的那一条之后接着发', async () => {
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const events = memoryEvents();
    await events.append('g1', event(1));
    await events.append('g1', event(2));
    await events.append('g1', event(3));
    const hub = hubOn(pub, sub);

    const collected = take(gameEvents({ events, hub, gameId: 'g1', after: 2 }), 1);
    sub.deliver(wire(4));

    // 3 号那条是断线那一段里积压的，重连要补上；1、2 早就看过了。
    expect(seqs(await collected)).toEqual([3]);
  });

  it('补积压那一段里到的事件不漏，也不因为两边都有而发两遍', async () => {
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const events = memoryEvents();
    await events.append('g1', event(1));
    const hub = hubOn(pub, sub);

    const collected = take(gameEvents({ events, hub, gameId: 'g1', after: 0 }), 2);
    // 挂上之后、台账读出来之前到的：它们落在中转的缓冲里，台账里还没有。
    // 头一条正好是台账里那条推回来的，靠序号认出来只发一次，紧接着那条得跟上。
    sub.deliver(wire(1));
    sub.deliver(wire(2));

    expect(seqs(await collected)).toEqual([1, 2]);
  });

  it('只收自己这一局的：别的局推到同一条频道上也不串台', async () => {
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const events = memoryEvents();
    await events.append('g1', event(1));
    const hub = hubOn(pub, sub);

    const collected = take(gameEvents({ events, hub, gameId: 'g1', after: 0 }), 2);
    sub.deliver({ ...(wire(9) as object), gameId: 'g2' });
    sub.deliver(wire(2));

    expect(seqs(await collected)).toEqual([1, 2]);
  });

  it('取消订阅就把那一头松开：后来挂上的人不会收到上一轮留下的', async () => {
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const hub = hubOn(pub, sub);

    const subscription = gameEvents({
      events: memoryEvents(),
      hub,
      gameId: 'g1',
      after: 0,
    }).subscribe();
    sub.deliver(wire(1));
    subscription.unsubscribe();

    const seen: GameEvent[] = [];
    hub.attach('g1').live.subscribe((row) => seen.push(row));

    expect(seen).toEqual([]);
  });

  it('推出去的与推回来的是一条：台账行的幂等键不上频道', async () => {
    const pub = new FakeRedis();
    const hub = hubOn(pub, new FakeRedis());

    await hub.publish('g1', event(7));

    expect(JSON.parse(pub.published[0]!)).toEqual({
      gameId: 'g1',
      event: {
        seq: 7,
        day: 1,
        kind: EVENT_KINDS.OTHER,
        text: '第 7 条',
        audience: ['p1'],
      },
    });
  });
});
