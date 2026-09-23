import type {
  ActionDetailResponse,
  ActionStep,
  ActionSummary,
  PendingAction,
} from '@werewolf/shared';
import { CheckIcon, ChevronRightIcon, CircleAlertIcon, LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { fetchActionDetail } from '@/lib/api-client';
import { errorMessage } from '@/lib/http';
import { actionTypeName } from '@/lib/labels';
import type { LiveAction } from '@/lib/preview';
import { SpeakerLabel } from './SpeakerLabel';

function thinkingTime(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

const NODE_NAMES: Record<string, string> = {
  generate: '生成',
  critique: '复核',
  revise: '修订',
  finalize: '确认结果',
};
const STATUS_NAMES = { running: '执行中', completed: '已完成', failed: '失败' };

function decisionText(value: unknown): string {
  if (value === null) return '不行动';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return `${value} 号`;
  if (typeof value === 'string')
    return value === 'left' ? '从左侧开始' : value === 'right' ? '从右侧开始' : value;
  if (typeof value === 'object' && 'kind' in value) {
    switch (value.kind) {
      case 'antidote':
        return '使用解药';
      case 'none':
        return '不使用药水';
      case 'tear':
        return '撕毁警徽';
      case 'poison':
        return `对 ${'seatNo' in value ? value.seatNo : ''} 号使用毒药`;
      case 'transfer':
        return `将警徽交给 ${'seatNo' in value ? value.seatNo : ''} 号`;
    }
  }
  return JSON.stringify(value);
}

function nodeContent(step: ActionStep, actionType: string): string {
  if (
    actionType === 'speech' ||
    !['generate', 'revise'].includes(step.name) ||
    step.status !== 'completed'
  )
    return step.content;
  try {
    return decisionText(JSON.parse(step.content));
  } catch {
    return decisionText(step.content);
  }
}

function resultText(action: ActionSummary): string {
  if (typeof action.decision === 'boolean') {
    if (action.actionType === 'wolf_explode') return action.decision ? '选择自爆' : '不自爆';
    if (action.actionType === 'sheriff_candidacy') return action.decision ? '上警' : '不上警';
    if (action.actionType === 'sheriff_withdraw') return action.decision ? '退水' : '不退水';
  }
  return decisionText(action.decision);
}

function StatusIcon({ status }: { status: ActionStep['status'] }) {
  if (status === 'running') return <LoaderCircleIcon className="size-3.5 animate-spin" />;
  if (status === 'failed') return <CircleAlertIcon className="size-3.5 text-destructive" />;
  return <CheckIcon className="size-3.5" />;
}

export function Thinking({
  text,
  streaming = false,
  thinkingMs,
}: {
  text: string;
  streaming?: boolean;
  thinkingMs?: number | null;
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  return (
    <Collapsible open={expanded ?? streaming} onOpenChange={setExpanded} className="min-w-0">
      <CollapsibleTrigger className="group flex items-center gap-1 py-1 text-xs text-muted-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
        {streaming ? '正在思考' : '思考过程'}
        {thinkingMs != null ? <span> · {thinkingTime(thinkingMs)}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="border-l pl-3 text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-muted-foreground">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Steps({
  steps,
  actionType,
  stopped = false,
}: {
  steps: ActionStep[];
  actionType: string;
  stopped?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 border-l pl-4">
      {steps.map((step) => (
        <div key={step.id} className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <StatusIcon status={stopped && step.status === 'running' ? 'failed' : step.status} />
            <span>{NODE_NAMES[step.name] ?? step.name}</span>
            <span>
              {stopped && step.status === 'running' ? '已中断' : STATUS_NAMES[step.status]}
            </span>
          </div>
          {step.reasoning ? (
            <Thinking
              text={step.reasoning}
              streaming={!stopped && step.status === 'running' && !step.content}
              thinkingMs={step.thinkingMs}
            />
          ) : null}
          {step.content && actionType === 'speech' && ['generate', 'revise'].includes(step.name) ? (
            <SpeechDraft step={step} stopped={stopped} />
          ) : step.content ? (
            <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
              {nodeContent(step, actionType)}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SpeechDraft({ step, stopped }: { step: ActionStep; stopped: boolean }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  return (
    <Collapsible
      open={expanded ?? (!stopped && step.status === 'running')}
      onOpenChange={setExpanded}
      className="mt-1"
    >
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
        {step.name === 'revise' ? '修订稿' : '发言草稿'}
        {step.status === 'running' ? '（未发布）' : '（过程记录）'}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1 border-l pl-3 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere text-muted-foreground">
          {step.content}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 长篇思考按需读取，不随对局轮询反复下载。 */
export function ActionRow({
  gameId,
  action,
  stopped = false,
  inline = false,
  speakerName,
}: {
  gameId: string;
  action: ActionSummary | (PendingAction & { seatNo: number });
  stopped?: boolean;
  inline?: boolean;
  speakerName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ActionDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const completed = 'decision' in action;
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await fetchActionDetail(gameId, action.actionKey));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="min-w-0 space-y-2">
      <Collapsible
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (value && (!detail || !completed) && !loading) void load();
        }}
      >
        <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-2 border-b pb-2 text-left text-xs text-muted-foreground">
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
          {inline ? (
            <span>思考与执行过程</span>
          ) : (
            <SpeakerLabel
              seatNo={action.seatNo}
              name={speakerName}
              action={actionTypeName(action.actionType)}
            />
          )}
          {completed && action.thinkingMs != null ? (
            <span>思考用时 {thinkingTime(action.thinkingMs)}</span>
          ) : null}
          <span className="ml-auto">
            {completed
              ? `已完成${action.hasReasoning ? ' · 含思考过程' : ''}`
              : stopped
                ? '已中断'
                : '执行中'}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          {completed ? <p className="mb-3 text-xs text-muted-foreground">{action.task}</p> : null}
          {loading ? <p className="text-xs text-muted-foreground">读取过程…</p> : null}
          {error ? (
            <div role="alert" className="text-xs text-destructive">
              {error}
              <Button variant="ghost" size="sm" onClick={() => void load()}>
                重试
              </Button>
            </div>
          ) : null}
          {detail ? (
            <>
              {detail.steps.length ? (
                <Steps steps={detail.steps} actionType={action.actionType} stopped={stopped} />
              ) : (
                <p className="text-xs text-muted-foreground">这条记录还没有保存的节点执行详情。</p>
              )}
              {detail.reasoning &&
              !detail.steps.some((step) => step.reasoning === detail.reasoning) ? (
                <Thinking text={detail.reasoning} />
              ) : null}
            </>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
      {completed && !inline ? (
        <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
          {resultText(action)}
        </p>
      ) : null}
    </div>
  );
}

export function LiveActionRow({
  action,
  stopped,
  speakerName,
}: {
  action: LiveAction;
  stopped: boolean;
  speakerName?: string;
}) {
  const timed = action.steps.filter((step) => step.thinkingMs != null);
  const total = timed.reduce((sum, step) => sum + step.thinkingMs!, 0);
  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="group mb-3 flex w-full flex-wrap items-center gap-2 border-b pb-2 text-left text-xs text-muted-foreground">
        <ChevronRightIcon className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
        <SpeakerLabel
          seatNo={action.seatNo}
          name={speakerName}
          action={actionTypeName(action.actionType)}
        />
        {timed.length ? <span className="ml-auto">思考用时 {thinkingTime(total)}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Steps steps={action.steps} actionType={action.actionType} stopped={stopped} />
      </CollapsibleContent>
    </Collapsible>
  );
}
