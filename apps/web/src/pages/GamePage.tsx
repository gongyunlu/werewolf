import {
  GameEventSchema,
  GAME_STATUSES,
  PreviewChunkSchema,
  type ActionSummary,
  type BoardSummary,
  type GameDetail,
  type GameEvent,
  type PendingAction,
} from '@werewolf/shared';
import { Fragment, memo, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { ZodType } from 'zod';
import { GameReview } from '@/components/game-review/GameReview';
import { ActionRow, LiveActionRow } from '@/components/game-watch/ActionRow';
import { PlayerCard } from '@/components/game-watch/PlayerCard';
import { SceneRow } from '@/components/game-watch/SceneRow';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Marker, MarkerContent } from '@/components/ui/marker';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useEventStream } from '@/hooks/useEventStream';
import { fetchActionSummaries, fetchBoards, fetchGameDetail, runGame } from '@/lib/api-client';
import { errorMessage } from '@/lib/http';
import {
  factionName,
  PERSPECTIVE_NAMES,
  PERSPECTIVES,
  statusName,
  type Perspective,
} from '@/lib/labels';
import { mergePreview, type LiveAction } from '@/lib/preview';
import { phaseName, timelineRows } from '@/lib/timeline';
import { cn } from '@/lib/utils';

function parsed<T>(schema: ZodType<T>, data: string): T | null {
  try {
    const result = schema.safeParse(JSON.parse(data));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const History = memo(function History({
  gameId,
  events,
  actions,
  pending,
  players,
  roster,
  playerCount,
}: {
  gameId: string;
  events: GameEvent[];
  actions: ActionSummary[];
  pending: PendingAction[];
  players: GameDetail['players'];
  roster: GameDetail['roster'];
  playerCount: number;
}) {
  const rows = timelineRows(events, actions, pending);
  return rows.map((row, index) => {
    const pendingPlayer = row.pending
      ? players.find((player) => player.id === row.pending!.actorId)
      : null;
    return (
      <Fragment key={row.id}>
        {index === 0 || rows[index - 1].day !== row.day || rows[index - 1].phase !== row.phase ? (
          <MessageScrollerItem messageId={`day-${row.id}`}>
            <Marker variant="separator">
              <MarkerContent>
                第 {row.day} 天 · {phaseName(row.phase)}
              </MarkerContent>
            </Marker>
          </MessageScrollerItem>
        ) : null}
        {row.event?.kind !== 'system' &&
        (index === 0 ||
          rows[index - 1].day !== row.day ||
          rows[index - 1].phase !== row.phase ||
          rows[index - 1].activity !== row.activity) ? (
          <MessageScrollerItem messageId={`activity-${row.id}`}>
            <h2 className="pt-2 text-sm font-medium text-muted-foreground">{row.activity}</h2>
          </MessageScrollerItem>
        ) : null}
        <MessageScrollerItem messageId={row.id}>
          {row.event ? (
            <SceneRow
              event={row.event}
              speakerName={
                roster.find((seat) => row.event!.text.startsWith(`${seat.seatNo} 号`))?.name
              }
              privateResult={row.event.audience.length < playerCount}
            >
              {row.action ? <ActionRow gameId={gameId} action={row.action} inline /> : null}
            </SceneRow>
          ) : row.pending ? (
            <ActionRow
              gameId={gameId}
              action={{ ...row.pending, seatNo: pendingPlayer!.seatNo }}
              stopped
              speakerName={roster.find((seat) => seat.seatNo === pendingPlayer?.seatNo)?.name}
            />
          ) : (
            <ActionRow
              gameId={gameId}
              action={row.action!}
              speakerName={roster.find((seat) => seat.seatNo === row.action!.seatNo)?.name}
            />
          )}
        </MessageScrollerItem>
      </Fragment>
    );
  });
});

/** 换局即重建订阅与滚动状态。 */
export function GamePage() {
  const { gameId = '' } = useParams();
  return <GameWatch key={gameId} gameId={gameId} />;
}

function GameWatch({ gameId }: { gameId: string }) {
  const [searchParams] = useSearchParams();
  const [game, setGame] = useState<GameDetail | null>(null);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [actions, setActions] = useState<ActionSummary[]>([]);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [live, setLive] = useState<Record<string, LiveAction>>({});
  const [perspective, setPerspective] = useState<Perspective>(PERSPECTIVES.GOD);
  const [error, setError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [polling, setPolling] = useState(true);
  const ended = game?.status === GAME_STATUSES.FINISHED || game?.status === GAME_STATUSES.FAILED;
  const reviewing =
    game?.status === GAME_STATUSES.FINISHED && searchParams.get('view') === 'review';

  useEffect(() => {
    let alive = true;
    void fetchBoards()
      .then(({ boards: loaded }) => {
        if (alive) setBoards(loaded);
        return undefined;
      })
      .catch((failure: unknown) => {
        if (alive) setError(errorMessage(failure));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!polling) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const [detail, initialHistory] = await Promise.allSettled([
        fetchGameDetail(gameId),
        fetchActionSummaries(gameId),
      ]);
      if (!alive) return;
      const status = detail.status === 'fulfilled' ? detail.value.game.status : null;
      // 并行读取的摘要可能早于终局；确认终局后再取一次，成功后才能停。
      const [history] =
        status === GAME_STATUSES.FINISHED
          ? await Promise.allSettled([fetchActionSummaries(gameId)])
          : [initialHistory];
      if (!alive) return;
      if (detail.status === 'fulfilled') setGame(detail.value.game);
      if (history.status === 'fulfilled') {
        setActions(history.value.actions);
        setPending(history.value.pending);
        const completedKeys = new Set(history.value.actions.map((action) => action.actionKey));
        setLive((current) =>
          Object.keys(current).some((key) => completedKeys.has(key))
            ? Object.fromEntries(Object.entries(current).filter(([key]) => !completedKeys.has(key)))
            : current,
        );
      }
      const failed = [detail, history].find((result) => result.status === 'rejected');
      setError(failed?.status === 'rejected' ? errorMessage(failed.reason) : null);
      if (failed || status !== GAME_STATUSES.FINISHED) {
        timer = setTimeout(() => void load(), status === GAME_STATUSES.FAILED ? 10000 : 3000);
      } else setPolling(false);
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [gameId, polling]);

  const stream = useEventStream(`/api/games/${gameId}/events`, (message) => {
    if (message.type === 'preview') {
      const chunk = parsed(PreviewChunkSchema, message.data);
      if (chunk)
        setLive((current) => ({
          ...current,
          [chunk.actionKey]: mergePreview(current[chunk.actionKey], chunk),
        }));
      return;
    }
    const event = parsed(GameEventSchema, message.data);
    if (event)
      setEvents((current) =>
        current.some((seen) => seen.seq === event.seq) ? current : [...current, event],
      );
  });

  const players = useMemo(
    () => (game?.players ?? []).toSorted((a, b) => a.seatNo - b.seatNo),
    [game],
  );
  const shown = useMemo(
    () =>
      perspective === PERSPECTIVES.GOD
        ? events
        : events.filter(
            (event) =>
              players.length > 0 && players.every((player) => event.audience.includes(player.id)),
          ),
    [events, perspective, players],
  );
  const shownActions = useMemo(
    () => (perspective === PERSPECTIVES.GOD ? actions : []),
    [actions, perspective],
  );
  const completed = new Set(actions.map((action) => action.actionKey));
  const historicalPending = useMemo(() => {
    const latestSeq = Math.max(
      0,
      ...events.map((event) => event.seq),
      ...actions.map((action) => action.ledgerSeq),
    );
    return pending.filter(
      (action) =>
        (ended || action.ledgerSeq < latestSeq) &&
        players.some((player) => player.id === action.actorId),
    );
  }, [pending, ended, events, actions, players]);
  const historicalKeys = new Set(historicalPending.map((action) => action.actionKey));
  const currentActions = Object.values(live).filter(
    (action) => !completed.has(action.actionKey) && !historicalKeys.has(action.actionKey),
  );
  const activeSeats = new Set(
    currentActions
      .filter((action) => action.steps.some((step) => step.status === 'running'))
      .map((action) => action.seatNo),
  );
  const shownPending = useMemo(
    () => (perspective === PERSPECTIVES.GOD ? historicalPending : []),
    [perspective, historicalPending],
  );
  const waitingActions = pending
    .filter((action) => !live[action.actionKey] && !historicalKeys.has(action.actionKey))
    .flatMap((action) => {
      const player = players.find((candidate) => candidate.id === action.actorId);
      return player ? [{ ...action, seatNo: player.seatNo }] : [];
    });
  const hasActivity =
    shown.length > 0 ||
    shownActions.length > 0 ||
    (perspective === PERSPECTIVES.GOD &&
      (currentActions.length > 0 || shownPending.length > 0 || waitingActions.length > 0));
  const half = Math.ceil(players.length / 2);
  const resume = async () => {
    setResuming(true);
    try {
      await runGame(gameId);
      setGame((current) => (current ? { ...current, status: GAME_STATUSES.QUEUED } : current));
      setPolling(true);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setResuming(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-[112rem] flex-col lg:h-[calc(100dvh-3rem)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">
            {boards.find((board) => board.id === game?.boardId)?.name ?? '对局观战'}
          </h1>
          <span className="font-mono text-xs text-muted-foreground">{gameId}</span>
          <Badge variant={game?.status === GAME_STATUSES.FAILED ? 'destructive' : 'secondary'}>
            {game ? statusName(game.status) : '读取中'}
            {game?.winner ? ` · 胜方 ${factionName(game.winner)}` : ''}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {game?.status === GAME_STATUSES.FAILED ? (
            <Button size="sm" disabled={resuming} onClick={() => void resume()}>
              {resuming ? '恢复中…' : '恢复对局'}
            </Button>
          ) : null}
          {game?.status === GAME_STATUSES.FINISHED ? (
            <Link
              className={buttonVariants({ variant: reviewing ? 'outline' : 'default', size: 'sm' })}
              to={reviewing ? `/games/${gameId}` : `/games/${gameId}?view=review`}
            >
              {reviewing ? '返回对局记录' : '赛后复盘'}
            </Link>
          ) : null}
          {!reviewing ? (
            <Tabs
              value={perspective}
              onValueChange={(value) => setPerspective(value as Perspective)}
            >
              <TabsList>
                {Object.values(PERSPECTIVES).map((value) => (
                  <TabsTrigger key={value} value={value}>
                    {PERSPECTIVE_NAMES[value]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : null}
          <Link className={buttonVariants({ variant: 'outline', size: 'sm' })} to="/games">
            回到列表
          </Link>
        </div>
      </div>
      {error ? (
        <p role="alert" className="px-6 pt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {game?.status === GAME_STATUSES.FAILED ? (
        <p className="px-6 pt-3 text-sm text-muted-foreground">
          对局已中断，已保存的记录仍可查看。
        </p>
      ) : null}
      {reviewing ? (
        <GameReview game={game} />
      ) : (
        <div
          className={cn(
            'grid min-h-0 flex-1 gap-5 p-4 lg:p-5',
            players.length > 0 &&
              'lg:grid-cols-[minmax(13rem,1fr)_minmax(0,2.8fr)_minmax(13rem,1fr)]',
          )}
        >
          {players.length > 0 ? (
            <aside
              className="grid min-h-0 min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1 lg:grid-rows-6"
              aria-label="左侧座位"
            >
              {players.slice(0, half).map((player) => (
                <PlayerCard
                  key={player.id}
                  player={player}
                  side="left"
                  seat={game?.roster.find((seat) => seat.seatNo === player.seatNo) ?? null}
                  active={!ended && activeSeats.has(player.seatNo)}
                />
              ))}
            </aside>
          ) : null}
          <section
            aria-label="对局动态"
            className="flex h-[70dvh] min-h-0 min-w-0 flex-col lg:h-full"
          >
            <div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>对局动态{perspective === PERSPECTIVES.CLOSED ? ' · 仅公开消息' : ''}</span>
              <span>
                {stream.connected
                  ? '已连上'
                  : stream.error
                    ? `已断开：${errorMessage(stream.error)}`
                    : '连接中'}
              </span>
            </div>
            <MessageScrollerProvider autoScroll defaultScrollPosition="end">
              <MessageScroller>
                <MessageScrollerViewport aria-label="对局消息滚动区域">
                  <MessageScrollerContent aria-label="对局消息" className="gap-4 px-1 pb-12">
                    {!hasActivity ? (
                      <MessageScrollerItem messageId="empty">
                        <p className="py-12 text-center text-sm text-muted-foreground">
                          {!players.length
                            ? '还没发牌。'
                            : events.length
                              ? '闭眼视角下，这一局还没有公开的事实。'
                              : '等待对局动态，玩家发言、投票与法官播报将在这里呈现。'}
                        </p>
                      </MessageScrollerItem>
                    ) : null}
                    <History
                      gameId={gameId}
                      events={shown}
                      actions={shownActions}
                      pending={shownPending}
                      players={players}
                      roster={game?.roster ?? []}
                      playerCount={players.length}
                    />
                    {perspective === PERSPECTIVES.GOD
                      ? waitingActions.map((action) => (
                          <MessageScrollerItem key={action.actionKey} messageId={action.actionKey}>
                            <ActionRow
                              gameId={gameId}
                              action={action}
                              speakerName={
                                game?.roster.find((seat) => seat.seatNo === action.seatNo)?.name
                              }
                            />
                          </MessageScrollerItem>
                        ))
                      : null}
                    {perspective === PERSPECTIVES.GOD
                      ? currentActions.map((action) => (
                          <MessageScrollerItem
                            key={action.actionKey}
                            messageId={`live-${action.actionKey}`}
                          >
                            <LiveActionRow
                              action={action}
                              stopped={ended}
                              speakerName={
                                game?.roster.find((seat) => seat.seatNo === action.seatNo)?.name
                              }
                            />
                          </MessageScrollerItem>
                        ))
                      : null}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>
          </section>
          {players.length > 0 ? (
            <aside
              className="grid min-h-0 min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1 lg:grid-rows-6"
              aria-label="右侧座位"
            >
              {players.slice(half).map((player) => (
                <PlayerCard
                  key={player.id}
                  player={player}
                  side="right"
                  seat={game?.roster.find((seat) => seat.seatNo === player.seatNo) ?? null}
                  active={!ended && activeSeats.has(player.seatNo)}
                />
              ))}
            </aside>
          ) : null}
        </div>
      )}
    </main>
  );
}
