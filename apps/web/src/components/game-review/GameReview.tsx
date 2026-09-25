import type { GameDetail, ReviewReport } from '@werewolf/shared';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { reviewIsRunning, useGameReview } from '@/hooks/useGameReview';
import { roleName } from '@/lib/labels';
import { decisionTitle, REVIEW_STATUS_NAMES } from '@/lib/review';
import { ReviewAnalysis, ReviewEvidence, type EvidenceSelection } from './ReviewAnalysis';

function ReportReader({ report, game }: { report: ReviewReport; game: GameDetail }) {
  const [selectedPlayer, setSelectedPlayer] = useState(report.evidence.players[0]?.id ?? '');
  const [selection, setSelection] = useState<EvidenceSelection | null>(null);
  const player = report.players.find((item) => item.playerId === selectedPlayer);
  const summary = report.units.find((unit) => unit.key === `player/${selectedPlayer}`);
  const outcome = report.units.find((unit) => unit.step === 'review_outcome');
  const targets = report.evidence.targets.filter((target) => target.actorId === selectedPlayer);
  const gaps = report.evidence.gaps.filter((gap) => gap.actorId === selectedPlayer);
  const items = report.evidence.players
    .toSorted((a, b) => a.seatNo - b.seatNo)
    .map((seat) => {
      const name = game.roster.find((item) => item.seatNo === seat.seatNo)?.name;
      const role = game.players.find((item) => item.id === seat.id)?.role;
      return {
        value: seat.id,
        label: `${seat.seatNo} 号${name ? ` · ${name}` : ''}${role ? ` · ${roleName(role)}` : ''}`,
      };
    });

  return (
    <>
      <Tabs defaultValue="players" className="flex flex-col gap-4">
        <TabsList aria-label="复盘内容">
          <TabsTrigger value="players">玩家复盘</TabsTrigger>
          <TabsTrigger value="outcome">全局分析</TabsTrigger>
        </TabsList>
        <TabsContent value="players">
          <Card>
            <CardHeader>
              <CardTitle>玩家当时视角</CardTitle>
              <CardDescription>
                逐步分析仅依据行动当时可见的信息，玩家汇总串联这些决策。后来的身份与赛果不作为当时已知信息。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <Select
                items={items}
                value={selectedPlayer}
                onValueChange={(value) => value && setSelectedPlayer(value)}
              >
                <SelectTrigger aria-label="选择复盘玩家" className="max-w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {items.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                决策分析已完成 {player?.evaluatedDecisions ?? 0} / {targets.length} 条
              </p>
              {gaps.length ? (
                <ul className="list-disc pl-5 text-sm text-muted-foreground">
                  {gaps.map((gap) => (
                    <li key={gap.actionKey}>{gap.reason}</li>
                  ))}
                </ul>
              ) : null}
              <section aria-label="玩家汇总" className="flex flex-col gap-3">
                <h3 className="font-medium">玩家汇总</h3>
                {summary?.result ? (
                  <ReviewAnalysis report={report} unit={summary} onEvidence={setSelection} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {player?.limitation ?? '玩家汇总尚未生成，已完成的逐步分析可在下方阅读。'}
                  </p>
                )}
              </section>
            </CardContent>
          </Card>
          <section aria-label="逐步决策分析" className="flex flex-col gap-3" key={selectedPlayer}>
            <h3 className="font-medium">逐步决策分析</h3>
            {targets.map((target, index) => {
              const unit = report.units.find((item) => item.key === `decision/${target.actionKey}`);
              return (
                <Collapsible key={target.actionKey} className="rounded-lg border">
                  <CollapsibleTrigger
                    render={<Button variant="ghost" />}
                    className="h-auto w-full justify-between gap-3 whitespace-normal px-4 py-3 text-left"
                  >
                    <span>
                      {index + 1}. {decisionTitle(target)}
                    </span>
                    <Badge variant="secondary">
                      {unit?.result ? '已完成' : unit ? '待完成' : '待生成'}
                    </Badge>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="px-4 pb-4">
                    {unit?.result ? (
                      <ReviewAnalysis report={report} unit={unit} onEvidence={setSelection} />
                    ) : (
                      <p className="text-sm text-muted-foreground">这条决策分析尚未完成。</p>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </section>
        </TabsContent>
        <TabsContent value="outcome">
          <Card>
            <CardHeader>
              <CardTitle>赛后全知视角</CardTitle>
              <CardDescription>
                结合完整事件、终局身份与赛果解释全局过程；这里的信息不代表玩家当时知道。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {outcome?.result ? (
                <ReviewAnalysis report={report} unit={outcome} onEvidence={setSelection} />
              ) : (
                <p className="text-sm text-muted-foreground">全局分析尚未生成。</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      {selection ? (
        <ReviewEvidence report={report} selection={selection} onClose={() => setSelection(null)} />
      ) : null}
    </>
  );
}

export function GameReview({ game }: { game: GameDetail }) {
  const review = useGameReview(game.gameId);
  const { data, preview } = review;
  const report = data?.report;
  const completed = report?.units.filter((unit) => unit.result).length ?? 0;
  const pending = report?.units.find((unit) => !unit.result);
  const playerName = (actorId: string) => {
    const seat = game.players.find((player) => player.id === actorId);
    return seat ? `${seat.seatNo} 号` : actorId;
  };
  const pendingTarget = report?.evidence.targets.find(
    (target) => pending?.key === `decision/${target.actionKey}`,
  );
  const pendingName = pendingTarget
    ? `${playerName(pendingTarget.actorId)} · ${decisionTitle(pendingTarget)}`
    : pending?.step === 'review_player'
      ? `${playerName(pending.key.slice('player/'.length))} · 玩家汇总`
      : pending?.step === 'review_outcome'
        ? '全局分析'
        : null;

  return (
    <section aria-label="赛后复盘" className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 pb-8">
        <Card>
          <CardHeader>
            <CardTitle>赛后复盘</CardTitle>
            <CardDescription>
              查看决策分析、玩家汇总与全局赛果。复盘提供可讨论的分析，不打分、不排名。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <output className="flex flex-wrap items-center gap-3">
              <Badge variant={data?.status === 'failed' ? 'destructive' : 'secondary'}>
                {review.submitting
                  ? '正在提交…'
                  : data
                    ? (REVIEW_STATUS_NAMES[data.status] ?? `任务状态：${data.status}`)
                    : '读取复盘状态…'}
              </Badge>
              {preview ? (
                <span className="text-sm">
                  已完成 {completed} / {preview.expectedLogicalCalls} 项分析
                </span>
              ) : null}
              {pendingName ? (
                <span className="text-sm text-muted-foreground">
                  {data?.status === 'active' ? '当前生成' : '待完成'}：{pendingName}
                </span>
              ) : null}
            </output>
            {preview ? (
              <div className="flex flex-col gap-3">
                <h3 className="font-medium">复盘覆盖范围</h3>
                <p className="text-sm">
                  {preview.players} 位玩家 · {preview.decisions} 条可分析决策 ·{' '}
                  {preview.expectedLogicalCalls - preview.decisions - 1} 份玩家汇总 · 1 份全局分析
                </p>
                <p className="text-sm text-muted-foreground">
                  预计 {preview.expectedLogicalCalls} 项分析调用；决策证据{' '}
                  {preview.evidenceCharacters.decisions.toLocaleString()} 字符，全局证据{' '}
                  {preview.evidenceCharacters.omniscient.toLocaleString()} 字符。
                  {preview.note}
                </p>
                {preview.gaps.length ? (
                  <Collapsible>
                    <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
                      查看 {preview.gaps.length} 条证据缺口
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-sm text-muted-foreground">
                        {preview.gaps.map((gap) => (
                          <li key={gap.actionKey}>
                            {playerName(gap.actorId)}：{gap.reason}
                          </li>
                        ))}
                      </ul>
                    </CollapsibleContent>
                  </Collapsible>
                ) : (
                  <p className="text-sm text-muted-foreground">未发现证据缺口。</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">正在读取复盘覆盖范围…</p>
            )}
            {data?.failure ? (
              <p role="alert" className="text-sm text-destructive">
                {data.failure}
              </p>
            ) : null}
            {data?.status === 'interrupted' ? (
              <p className="text-sm">复盘已中断，已保存的分析仍可阅读。续跑将从保存的进度继续。</p>
            ) : null}
            {reviewIsRunning(data?.status ?? '') ? (
              <p className="text-sm text-muted-foreground">
                状态会自动更新，离开或刷新页面后可继续查看。
              </p>
            ) : null}
            {review.previewError ? (
              <p role="alert" className="text-sm text-destructive">
                覆盖范围读取失败：{review.previewError}
              </p>
            ) : null}
            {review.readError ? (
              <p role="alert" className="text-sm text-destructive">
                复盘读取失败，正在重试：{review.readError}。已展示内容保留，当前状态尚未确认。
              </p>
            ) : null}
            {review.submitError ? (
              <p role="alert" className="text-sm text-destructive">
                提交失败：{review.submitError}
              </p>
            ) : null}
          </CardContent>
          <CardFooter className="flex flex-wrap gap-3">
            {data && ['not_started', 'failed', 'interrupted'].includes(data.status) ? (
              <Button disabled={!review.canStart} onClick={() => void review.start()}>
                {review.submitting
                  ? '正在提交…'
                  : data.status === 'not_started'
                    ? '生成复盘'
                    : '续跑复盘'}
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={review.loading || review.submitting}
              onClick={review.refresh}
            >
              {review.loading ? '读取中…' : '刷新状态'}
            </Button>
            <span className="text-xs text-muted-foreground">
              仅手动触发生成；续跑保留已完成内容。
            </span>
          </CardFooter>
        </Card>
        {report ? <ReportReader report={report} game={game} /> : null}
      </div>
    </section>
  );
}
