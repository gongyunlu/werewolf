import type { GameExecution, GameStatus } from '@werewolf/shared';
import { CircleAlertIcon, LoaderCircleIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { actionTypeName, stepName } from '@/lib/labels';
import { phaseName } from '@/lib/timeline';

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

const FAILURES: Record<string, string> = {
  transient: '模型请求失败',
  budget_exhausted: '模型请求多次失败',
  fatal: '模型服务拒绝请求',
  invalid_output: '模型返回结果不符合要求',
  deadline: '模型请求已中止',
  internal: '执行过程发生错误',
};

/** 计时只更新状态栏，避免整段对局记录每秒重画。 */
export function ExecutionStatus({
  execution,
  status,
  day,
  receivedAt,
  unavailable,
  showPlayers,
  players,
  roster,
}: {
  execution: GameExecution | null;
  status: GameStatus;
  day: number | null;
  receivedAt: number | null;
  unavailable: boolean;
  showPlayers: boolean;
  players: { id: string; seatNo: number }[];
  roster: { seatNo: number; name: string }[];
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (status === 'finished') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);

  if (status === 'finished') return null;
  const age = receivedAt === null ? null : Math.max(0, now - receivedAt);
  const stale = unavailable || age === null || age > 10000;
  const active = !stale && status === 'running' && execution?.workerActive === true;
  const label = stale
    ? '状态待确认'
    : status === 'failed'
      ? '已中断'
      : status === 'queued'
        ? '排队中'
        : active
          ? '任务执行中'
          : '状态待确认';
  // 服务端计算过的时间差加上本地经过的时间，不受两端时钟偏差影响。
  const serverNow = execution ? Date.parse(execution.checkedAt) + (active ? age! : 0) : 0;

  return (
    <section
      aria-label="执行状态"
      className="mb-3 flex shrink-0 flex-col gap-2 border-b pb-3 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant={status === 'failed' ? 'destructive' : 'secondary'}>
          {active ? (
            <span className="animate-spin motion-reduce:animate-none" aria-hidden="true">
              <LoaderCircleIcon className="size-3" />
            </span>
          ) : stale || status === 'failed' || status === 'running' ? (
            <CircleAlertIcon aria-hidden="true" />
          ) : null}
          {label}
        </Badge>
        <span className="text-muted-foreground">
          {age === null ? '尚未同步' : `最近同步：${age < 1000 ? '刚刚' : `${duration(age)}前`}`}
        </span>
      </div>
      {stale ? (
        <output>无法确认最新执行状态，等待重新同步。</output>
      ) : status === 'queued' ? (
        <p>等待任务开始。</p>
      ) : status === 'running' && !execution?.workerActive ? (
        <output>未确认到活跃的执行任务，等待后端更新状态。</output>
      ) : null}
      {execution ? (
        <>
          <p className="font-medium">
            {day !== null ? `第 ${day} 天 · ` : ''}
            <span>
              {execution.phase === 'dayEnd'
                ? `日终整理 · 已完成 ${execution.completed} / ${execution.total}`
                : `${phaseName(execution.phase)} · 已完成 ${execution.completed} 项行动`}
            </span>
          </p>
          {showPlayers && execution.pending.length ? (
            <ul className="flex max-h-28 flex-col gap-1.5 overflow-y-auto text-muted-foreground">
              {execution.pending.map((action) => {
                const player = players.find((item) => item.id === action.actorId);
                const name = roster.find((item) => item.seatNo === player?.seatNo)?.name;
                const attempt = action.attempt;
                const failure = action.failureCode ?? attempt?.failureCode;
                const failed =
                  status === 'failed' ||
                  action.callStatus === 'failed' ||
                  action.callStatus === 'cancelled';
                const processing =
                  action.callStatus === 'accepted' || attempt?.status === 'succeeded';
                return (
                  <li
                    key={action.actionKey}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1"
                  >
                    <span>
                      {player ? `${player.seatNo} 号${name ? ` ${name}` : ''}` : '玩家'} ·{' '}
                      {actionTypeName(action.actionType)}
                    </span>
                    {failed ? (
                      <span>{FAILURES[failure ?? ''] ?? '执行已中断'}</span>
                    ) : !active ? (
                      <span>上次记录：尚未完成</span>
                    ) : processing ? (
                      <span>整理结果中</span>
                    ) : attempt?.status === 'failed' ? (
                      <span>等待重试</span>
                    ) : (
                      <span>
                        {action.step ? `${stepName(action.step)} · ` : ''}
                        {attempt ? '等待模型响应' : '准备中'}
                      </span>
                    )}
                    {attempt ? (
                      <>
                        <span>
                          {active && !failed && !processing && attempt.number > 1
                            ? '重试中 · '
                            : ''}
                          第 {attempt.number} / {execution.maxAttempts} 次尝试
                        </span>
                        {active && !failed && attempt.status === 'started' ? (
                          <span className="tabular-nums">
                            本次已等待 {duration(serverNow - Date.parse(attempt.startedAt))}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : active ? (
            <p className="text-muted-foreground">正在处理对局，等待下一条动态。</p>
          ) : null}
          {active &&
          showPlayers &&
          execution.pending.some((action) => action.attempt?.status === 'started') ? (
            <p className="text-muted-foreground">
              单次请求最多等待 {duration(execution.requestTimeoutMs)}；计时表示等待时长。
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
