import { GAME_STATUSES, type BoardSummary, type GameSummary } from '@werewolf/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CreateGameDialog } from '@/components/CreateGameDialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { fetchBoards, fetchGames, runGame } from '@/lib/api-client';
import { errorMessage, isCanceled } from '@/lib/http';
import { factionName, statusName } from '@/lib/labels';

/** 列表跟着队列走：有人开局、有人跑完，几秒内得反映出来。 */
const REFRESH_MS = 5000;

/** 卡上那一行进度：还没落过锚点的那一小会儿天数与存活人数都是空的。 */
function progressOf(game: GameSummary): string {
  if (game.day === null || game.aliveCount === null) return '还没发牌';

  return `第 ${game.day} 天 · 存活 ${game.aliveCount} 人`;
}

export function GamesPage() {
  const navigate = useNavigate();
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [games, setGames] = useState<GameSummary[]>([]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [resuming, setResuming] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const load = async () => {
      const [boardList, gameList] = await Promise.allSettled([fetchBoards(), fetchGames()]);

      if (!alive) {
        return;
      }

      if (boardList.status === 'rejected') throw boardList.reason;
      if (gameList.status === 'rejected') throw gameList.reason;
      setBoards(boardList.value.boards);
      setGames(gameList.value.games);
      // 这一轮拿到了就把上一轮的红字撤掉：后端起晚了的那一会儿不该一直挂着。
      setError(null);
    };

    const tick = async () => {
      try {
        await load();
      } catch (failure) {
        if (alive && !isCanceled(failure)) {
          setError(errorMessage(failure));
        }
      } finally {
        if (alive) setLoading(false);
        if (alive) timer = setTimeout(() => void tick(), REFRESH_MS);
      }
    };

    void tick();

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  /** 断了的那一局接回来：排上队就进观战页看着它跑。 */
  const resume = async (gameId: string) => {
    setError(null);
    setResuming(gameId);

    try {
      await runGame(gameId);
      navigate(`/games/${gameId}`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setResuming(null);
    }
  };

  const boardName = (id: string) => boards.find((board) => board.id === id)?.name ?? id;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">对局列表</h1>
          <p className="text-sm text-muted-foreground">观看正在进行的对局，回看已经结束的比赛。</p>
        </div>
        <Button disabled={boards.length === 0} onClick={() => setOpening(true)}>
          开一局
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {loading ? (
        <p className="text-center text-sm text-muted-foreground">读取中…</p>
      ) : games.length === 0 && !error ? (
        <p className="text-center text-sm text-muted-foreground">还没有对局。</p>
      ) : (
        <div className="flex flex-col gap-3">
          {games.map((game) => (
            <Card
              key={game.gameId}
              className="gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <CardHeader>
                <CardTitle className="font-mono text-sm">{game.gameId}</CardTitle>
                <CardDescription>{boardName(game.boardId)}</CardDescription>
                <CardAction>
                  <Badge
                    variant={game.status === GAME_STATUSES.FAILED ? 'destructive' : 'secondary'}
                  >
                    {statusName(game.status)}
                  </Badge>
                </CardAction>
              </CardHeader>

              <CardContent className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground sm:col-start-1 sm:row-start-2">
                <span>胜方：{game.winner ? factionName(game.winner) : '—'}</span>
                <span>{progressOf(game)}</span>
                <span>
                  开局：{new Date(game.createdAt).toLocaleString('zh-CN', { hour12: false })}
                </span>
              </CardContent>

              <CardContent className="flex justify-end gap-2 sm:col-start-2 sm:row-span-2 sm:row-start-1">
                {/* 没分出胜负的才谈得上接着跑：分完了那局后端也不收 */}
                {game.status === GAME_STATUSES.FAILED ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={resuming === game.gameId}
                    onClick={() => void resume(game.gameId)}
                  >
                    {resuming === game.gameId ? '恢复中…' : '续跑'}
                  </Button>
                ) : null}
                <Link
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  to={`/games/${game.gameId}`}
                >
                  观战
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateGameDialog
        open={opening}
        onOpenChange={setOpening}
        boards={boards}
        onCreated={(gameId) => navigate(`/games/${gameId}`)}
      />
    </main>
  );
}
