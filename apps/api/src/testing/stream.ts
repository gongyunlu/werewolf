import { EventEmitter } from 'node:events';
import type { Observable } from 'rxjs';
import { EVENT_CHANNEL } from '../queue/game-event-hub';

/**
 * 频道那一头的替身：推出去的消息留在用例手上，收进来的自己往 'message' 上抛。
 * 真的 ioredis 要连上本机那个 Redis，用例不为这个挂依赖。
 */
export class FakeRedis extends EventEmitter {
  readonly status = 'ready';
  readonly published: string[] = [];
  /** 每条推出去的消息落在哪条频道上。推错频道等于没推，用例要能看出这一点。 */
  readonly channels: string[] = [];

  publish(channel: string, message: string): Promise<number> {
    this.published.push(message);
    this.channels.push(channel);
    return Promise.resolve(1);
  }

  subscribe(): Promise<number> {
    return Promise.resolve(1);
  }

  quit(): Promise<string> {
    return Promise.resolve('OK');
  }

  /** 把一条推给挂在它上面的那个中转，跟 Redis 发过来时一模一样。 */
  deliver(payload: unknown, channel = EVENT_CHANNEL): void {
    this.emit('message', channel, JSON.stringify(payload));
  }
}

/** 收够几条就断开：长连接用例里只需要看开头这几条。 */
export function take<T>(stream: Observable<T>, count: number): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const seen: T[] = [];
    const subscription = stream.subscribe({
      next: (value) => {
        seen.push(value);
        if (seen.length === count) {
          subscription.unsubscribe();
          resolve(seen);
        }
      },
      error: reject,
    });
  });
}
