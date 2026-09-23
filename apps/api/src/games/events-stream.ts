import type { GameEvent, PreviewChunk } from '@werewolf/shared';
import {
  concat,
  concatMap,
  defer,
  finalize,
  from,
  map,
  merge,
  mergeMap,
  of,
  type Observable,
} from 'rxjs';
import { wireOf, type GameEventHub } from '../queue/game-event-hub';
import type { EventStore } from '../store/events';

/**
 * 观战那条流上的两样东西：落了库的事实，和还没落库、正在生成的那一段。
 *
 * 预览那支带的 `sent` 是「此刻事实已发到哪一条」，那边拿它当 SSE 的 id（见 messageOf）。
 */
export type Streamed = { event: GameEvent } | { preview: PreviewChunk; sent: number };

export interface GameEventsInput {
  /** 这一局的台账。 */
  events: EventStore;
  /** 实时那一头。 */
  hub: Pick<GameEventHub, 'attach'>;
  gameId: string;
  /** 调用方已经看过的最后一条序号。第一回接进来是 0。 */
  after: number;
}

/**
 * 一局的事实流：先补台账里积压的，再接实时的。
 *
 * 两步之间到的那几条留在中转的缓冲里，跟积压合在一起按 seq 去重，
 * 所以既不会缺一条，也不会因为两边都收到而发两遍。取消订阅时把中转那一头松开。
 *
 * 正在生成的那一路并排接上：它不按序号，也不补历史，挂上来时先把此刻那一片给出去，
 * 之后来一片转一片。
 */
export function gameEvents(input: GameEventsInput): Observable<Streamed> {
  const { events, hub, gameId, after } = input;
  return defer(() => {
    const { live, preview, latest, resubscribed, release } = hub.attach(gameId);
    let sent = after;
    const pending = new Map<number, GameEvent>();

    const facts = merge(of(null), live, resubscribed.pipe(map(() => null))).pipe(
      concatMap(async (event) => {
        if (event && event.seq > sent) pending.set(event.seq, event);
        // 缺口或重新订阅时补读，连续到达的消息直接转发。
        if (!event || event.seq > sent + 1) {
          for (const row of await events.list(gameId, sent)) {
            if (row.seq > sent) pending.set(row.seq, wireOf(row));
          }
        }
        const ready: GameEvent[] = [];
        while (pending.has(sent + 1)) {
          sent += 1;
          ready.push(pending.get(sent)!);
          pending.delete(sent);
        }
        return ready;
      }),
      mergeMap((rows) => rows),
      map((event): Streamed => ({ event })),
    );

    return concat(
      // 先给这一刻正在写的那一段：不先给的话，中途接进来的人要等到下一片才知道有人在写。
      from(latest ? [{ preview: latest, sent }] : []),
      merge(facts, preview.pipe(map((one): Streamed => ({ preview: one, sent })))),
    ).pipe(finalize(release));
  });
}
