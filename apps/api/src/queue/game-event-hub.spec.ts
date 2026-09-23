import type { PreviewChunk } from '@werewolf/shared';
import type { Redis } from 'ioredis';
import { FakeRedis, take } from '../testing/stream';
import { EVENT_CHANNEL, GameEventHub, PREVIEW_CHANNEL } from './game-event-hub';

function hubOn(pub: FakeRedis, sub: FakeRedis): GameEventHub {
  return new GameEventHub(pub as unknown as Redis, sub as unknown as Redis);
}

/** 正在写的那一片：用例只关心它到目前写成了什么。 */
function chunk(text: string): PreviewChunk {
  return {
    actionKey: 'test-action',
    day: 1,
    seatNo: 1,
    actionType: 'speech',
    step: 'generate',
    callId: 'c1',
    channel: 'content',
    text,
  };
}

/** 往预览那条频道上推一片。 */
function write(sub: FakeRedis, gameId: string, text: string): void {
  sub.deliver({ gameId, preview: chunk(text) }, PREVIEW_CHANNEL);
}

describe('实时事件的中转', () => {
  it('频道上一条认不出的消息只丢掉，不能把进程带走', async () => {
    const sub = new FakeRedis();
    hubOn(new FakeRedis(), sub);

    // ioredis 那条监听器是同步的：这里抛出去就是未捕获异常，整台服务跟着走。
    expect(() => {
      sub.emit('message', EVENT_CHANNEL, '不是 JSON');
    }).not.toThrow();
  });

  it('看得见的那几局才收：没人看的不留', async () => {
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const hub = hubOn(pub, sub);

    const seen = take(hub.attach('g1').live, 1);
    sub.deliver({ gameId: 'g-nobody', event: { seq: 1, day: 1, kind: 'other', text: '没人看' } });
    sub.deliver({ gameId: 'g1', event: { seq: 2, day: 1, kind: 'other', text: '有人看' } });

    expect((await seen).map((event) => event.text)).toEqual(['有人看']);
  });

  it('预览推一片转一片，两条频道各走各的', async () => {
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const hub = hubOn(pub, sub);

    const watching = hub.attach('g1');
    const pushed: PreviewChunk[] = [];
    const facts: string[] = [];
    watching.preview.subscribe((one) => pushed.push(one));
    watching.live.subscribe((one) => facts.push(one.text));
    write(sub, 'g-nobody', '没人看的那局在说');
    write(sub, 'g1', '我坐');
    write(sub, 'g2', '别的局在说');
    write(sub, 'g1', '我坐 3 号');

    // 几条频道是共用的，按 gameId 分流在进程里做：别的局推过来的不串台。
    expect(pushed.map((one) => one.text)).toEqual(['我坐', '我坐 3 号']);
    // 预览是过程不是事实：它不进那条攒着事件回放的缓冲里。
    expect(facts).toEqual([]);
  });

  it('中途接进来的人先看此刻那一片：不然要等到下一片才知道有人在写', () => {
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const hub = hubOn(pub, sub);

    const first = hub.attach('g1');
    write(sub, 'g1', '我坐');
    write(sub, 'g1', '我坐 3 号');

    const second = hub.attach('g1');

    // 补的是最后那一片全文，不是前两片攒起来的一串。
    expect(second.latest?.text).toBe('我坐 3 号');
    first.release();
    second.release();
  });

  it('没人看的那几局不留：后来挂上的人不会拿到上一轮剩下的那一片', () => {
    const pub = new FakeRedis();
    const sub = new FakeRedis();
    const hub = hubOn(pub, sub);

    write(sub, 'g-nobody', '没人看');

    expect(hub.attach('g-nobody').latest).toBeNull();
  });
});
