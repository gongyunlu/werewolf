import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { GameEvent, PreviewChunk } from '@werewolf/shared';
import type { Redis } from 'ioredis';
import { Observable, ReplaySubject, Subject } from 'rxjs';
import type { StoredEvent } from '../store/events';

/** 实时事件走这一条频道。全部对局共用：按 gameId 分流在进程里做，不必为每局订一次。 */
export const EVENT_CHANNEL = 'werewolf:events';

/**
 * 正在生成的那一路走这一条。
 * 跟事实分开两条是因为留法不一样：事实那条要按序号补齐历史，预览补不了也不该补——
 * 它没有序号，也没有「第几片」这回事，每一条本身就是到此刻的全文。
 */
export const PREVIEW_CHANNEL = 'werewolf:preview';

/** 发布那条连接。 */
export const REDIS_PUB = Symbol('REDIS_PUB');

/** 订阅那条连接：订上频道之后它只能收，别拿它跑命令。 */
export const REDIS_SUB = Symbol('REDIS_SUB');

/** 频道上一条消息的样子。 */
interface PublishedEvent {
  gameId: string;
  event: GameEvent;
}

/** 预览那条频道上一条消息的样子。 */
interface PublishedPreview {
  gameId: string;
  preview: PreviewChunk;
}

/** 一局在看的这几样。没人看的不留，看了才建、看完就拆。 */
interface Watched {
  live: ReplaySubject<GameEvent>;
  preview: Subject<PreviewChunk>;
  /** 最后推到的那一片。中途接进来的人先看它，不然要等到下一片才知道有人在写。 */
  latest: PreviewChunk | null;
  watchers: number;
}

/** 台账行摊成推出去的那一条：幂等键是落库才用得上的，不上频道也不发给观战的人。 */
export function wireOf(event: StoredEvent): GameEvent {
  const flowPhase = /^node\/\d+\/\w+\/flow\/([^/]+)\//.exec(event.eventKey)?.[1];
  return {
    seq: event.seq,
    day: event.day,
    kind: event.kind,
    text: event.text,
    audience: [...event.audience],
    ...(flowPhase ? { phase: flowPhase } : {}),
  };
}

/**
 * 每局留的缓冲条数。比这更早的事实接进来时由台账补齐，不会丢；
 * 留一段是为了盖住「订阅上了、台账还没读完」那一小段窗口。
 */
const BUFFER = 200;

/**
 * 实时事件的中转：跑局那一头往频道上推，观战那一头从频道上收。
 *
 * 分进程也要走 Redis：跑局的、看局的各有各的连接，中间只有这一条路。
 */
@Injectable()
export class GameEventHub implements OnModuleDestroy {
  private readonly logger = new Logger(GameEventHub.name);
  private readonly byGame = new Map<string, Watched>();
  private readonly resubscribed = new Subject<void>();

  constructor(
    @Inject(REDIS_PUB) private readonly pub: Redis,
    @Inject(REDIS_SUB) private readonly sub: Redis,
  ) {
    for (const client of [pub, sub]) {
      // ioredis 连不上会往 'error' 上抛，没人接着就是一个未捕获异常把进程带走。
      client.on('error', (error: Error) => this.logger.error(`Redis 出错：${error.message}`));
    }

    this.sub.on('message', (channel, message) => this.dispatch(channel, message));
    const subscribe = () => {
      void this.sub
        .subscribe(EVENT_CHANNEL, PREVIEW_CHANNEL)
        .then(() => this.resubscribed.next())
        .catch((error: unknown) => this.logger.error(`订阅频道失败：${EVENT_CHANNEL}`, error));
    };
    // 等订阅确认后补读，覆盖断线期间以及重新订阅窗口内遗漏的事实。
    this.sub.on('ready', subscribe);
    if (this.sub.status === 'ready') subscribe();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.pub.quit(), this.sub.quit()]);
  }

  /** 落库之后把这条事实推给正在看的人。 */
  async publish(gameId: string, event: StoredEvent): Promise<void> {
    await this.pub.publish(EVENT_CHANNEL, JSON.stringify({ gameId, event: wireOf(event) }));
  }

  /** 模型写出来一片就推一片。它不落库：这是过程，不是事实。 */
  async publishPreview(gameId: string, preview: PreviewChunk): Promise<void> {
    await this.pub.publish(PREVIEW_CHANNEL, JSON.stringify({ gameId, preview }));
  }

  /**
   * 挂上这一局的实时流。
   * 返回时事实那条缓冲已经就位：这之后发生的事实一条不落地留在里面，
   * 所以调用方紧接着去读台账，两次之间那一段也不会丢。
   *
   * 预览那条不留缓冲，只把此刻正在写的这一片一并交出去：它每一条本身就是到此刻的全文，
   * 攒历史没有意义，中途接进来的人看到这一片也就跟上了。
   */
  attach(gameId: string): {
    live: Observable<GameEvent>;
    preview: Observable<PreviewChunk>;
    latest: PreviewChunk | null;
    resubscribed: Observable<void>;
    release: () => void;
  } {
    const entry = this.byGame.get(gameId) ?? {
      live: new ReplaySubject<GameEvent>(BUFFER),
      preview: new Subject<PreviewChunk>(),
      latest: null,
      watchers: 0,
    };

    entry.watchers += 1;
    this.byGame.set(gameId, entry);

    return {
      live: entry.live.asObservable(),
      preview: entry.preview.asObservable(),
      latest: entry.latest,
      resubscribed: this.resubscribed.asObservable(),
      release: () => {
        entry.watchers -= 1;
        if (entry.watchers === 0) {
          this.byGame.delete(gameId);
        }
      },
    };
  }

  /** 频道上一条消息解出来；认不出的丢掉。这条监听器是同步的，抛出去会把整个进程一起带走。 */
  private parse<T>(message: string): T | null {
    try {
      return JSON.parse(message) as T;
    } catch (error) {
      // 正在跑的那一局也在同一个进程里，一条认不出的消息不该把它带走，喊一声就够。
      this.logger.error(`频道上收到认不出的消息：${message}`, error);
      return null;
    }
  }

  private dispatch(channel: string, message: string): void {
    // 没人看的那几局直接丢：留着这些是给正在看的人用的。
    if (channel === PREVIEW_CHANNEL) {
      const parsed = this.parse<PublishedPreview>(message);
      const entry = parsed ? this.byGame.get(parsed.gameId) : undefined;
      if (!parsed || !entry) return;

      entry.latest = parsed.preview;
      entry.preview.next(parsed.preview);
      return;
    }

    const parsed = this.parse<PublishedEvent>(message);
    if (parsed) this.byGame.get(parsed.gameId)?.live.next(parsed.event);
  }
}
