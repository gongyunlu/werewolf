import { describe, expect, it } from 'vitest';
import { PendingRequests } from './pending';

const games = { method: 'get', url: '/games' };

describe('PendingRequests', () => {
  it('同键再次登记会取消上一次', () => {
    const pending = new PendingRequests();

    const first = pending.register(games);
    const second = pending.register(games);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('旧请求收尾时不会摘掉后发请求的登记', () => {
    const pending = new PendingRequests();

    const first = pending.register(games);
    const second = pending.register(games);
    first.release();

    const third = pending.register(games);

    expect(second.signal.aborted).toBe(true);
    expect(third.signal.aborted).toBe(false);
  });

  it('不同 url 互不影响', () => {
    const pending = new PendingRequests();

    const gamesRequest = pending.register({ method: 'get', url: '/games' });
    const agentsRequest = pending.register({ method: 'get', url: '/agents' });

    expect(gamesRequest.signal.aborted).toBe(false);
    expect(agentsRequest.signal.aborted).toBe(false);
  });

  it('params 不同的请求是两次请求，互不取消', () => {
    const pending = new PendingRequests();

    const first = pending.register({ method: 'get', url: '/games', params: { page: 1 } });
    const second = pending.register({ method: 'get', url: '/games', params: { page: 2 } });

    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
  });

  it('params 相同仍算同一个键，后发取消先发', () => {
    const pending = new PendingRequests();

    const first = pending.register({ method: 'get', url: '/games', params: { page: 1 } });
    const second = pending.register({ method: 'get', url: '/games', params: { page: 1 } });

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('data 不同的写请求互不取消', () => {
    const pending = new PendingRequests();

    const first = pending.register({ method: 'post', url: '/games/1/votes', data: { target: 2 } });
    const second = pending.register({ method: 'post', url: '/games/1/votes', data: { target: 3 } });

    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
  });

  it('调用方自己的 signal 中止时同样生效', () => {
    const pending = new PendingRequests();
    const caller = new AbortController();

    const { signal } = pending.register(games, caller.signal);
    caller.abort();

    expect(signal.aborted).toBe(true);
  });

  it('abortAll 取消所有在途请求', () => {
    const pending = new PendingRequests();

    const first = pending.register(games);
    const second = pending.register({ method: 'get', url: '/agents' });
    pending.abortAll();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });
});
