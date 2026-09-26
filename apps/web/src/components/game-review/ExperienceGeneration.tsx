import type { ExperienceGenerationResponse } from '@werewolf/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fetchExperienceGeneration, startExperienceGeneration } from '@/lib/experience-api';
import { errorMessage } from '@/lib/http';

const running = (status: string) =>
  ['waiting', 'active', 'delayed', 'paused', 'prioritized'].includes(status);
const labels: Record<string, string> = {
  not_started: '尚未生成',
  not_indexed: '已提炼，待建立索引',
  unavailable: '暂不可生成',
  waiting: '排队中',
  active: '生成中',
  failed: '生成失败',
  completed: '已完成',
  interrupted: '已中断',
};
export function ExperienceGeneration({
  gameId,
  playerId,
  agentId,
  completed,
}: {
  gameId: string;
  playerId: string;
  agentId?: string;
  completed: boolean;
}) {
  const [data, setData] = useState<ExperienceGenerationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!agentId || !completed || submitting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = await fetchExperienceGeneration(gameId, playerId, controller.signal);
        if (controller.signal.aborted) return;
        setData(value);
        setError(null);
        if (running(value.status)) timer = setTimeout(() => void load(), 2000);
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // 手动刷新与提交结束后都向服务端确认状态。
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [gameId, playerId, agentId, completed, revision, submitting]);
  const start = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await startExperienceGeneration(gameId, playerId);
    } catch (failure) {
      setSubmitError(errorMessage(failure));
    } finally {
      setSubmitting(false);
    }
  };
  const unavailable = !agentId
    ? '该历史玩家未绑定持久 agent，不能生成个人经验。'
    : !completed
      ? '完成本局复盘后，可以生成个人经验。'
      : null;
  return (
    <section aria-label="个人经验生成" className="flex flex-col gap-3 border-t pt-4">
      <h3 className="font-medium">提炼个人历史经验</h3>
      <p className="text-sm text-muted-foreground">
        结合本人复盘与原始证据，仅手动生成；可能没有值得保存的新经验。不会改写人工人设、策略或本局结果。
      </p>
      {unavailable ? (
        <p className="text-sm text-muted-foreground">{unavailable}</p>
      ) : (
        <>
          <output>
            <Badge variant={data?.status === 'failed' ? 'destructive' : 'secondary'}>
              {submitting
                ? '正在提交…'
                : data
                  ? (labels[data.status] ?? data.status)
                  : '读取经验状态…'}
            </Badge>
          </output>
          {data?.reason ? <p className="text-sm">{data.reason}</p> : null}
          {data?.generation?.result ? (
            <p className="text-sm">
              已保存 {data.generation.result.experiences.length} 条经验。
              {data.generation.result.reason}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {submitError ? (
            <p role="alert" className="text-sm text-destructive">
              提交失败：{submitError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {data &&
            ['not_started', 'not_indexed', 'failed', 'interrupted'].includes(data.status) ? (
              <Button size="sm" disabled={submitting} onClick={() => void start()}>
                {data.generation?.result
                  ? '建立或续跑经验索引'
                  : data.status === 'not_started'
                    ? '生成个人经验'
                    : '续跑经验生成'}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={submitting}
              onClick={() => setRevision((value) => value + 1)}
            >
              刷新经验状态
            </Button>
            <Link className="text-sm underline" to={`/agents?experience=${agentId}`}>
              查看与管理经验
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            新经验默认启用，建立索引后可供所有参赛者在后续行动中按当前情境检索；已经保存的行动输入保持不变。输入不代表模型明确采纳。
          </p>
        </>
      )}
    </section>
  );
}
