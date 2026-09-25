import type { ReviewReport, ReviewSource, ReviewUnit } from '@werewolf/shared';
import { Fragment, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { citationLabels, resolveCitation, sourceTitle } from '@/lib/review';

export interface EvidenceSelection {
  unit: ReviewUnit;
  label: string;
}

export function ReviewAnalysis({
  report,
  unit,
  onEvidence,
}: {
  report: ReviewReport;
  unit: ReviewUnit;
  onEvidence: (selection: EvidenceSelection) => void;
}) {
  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-7">
      {unit.result?.text.split(/(\b[EDO][1-9]\d*(?:-[EDO][1-9]\d*)?\b)/g).map((text, index) => {
        const labels = citationLabels(unit, text);
        if (!labels.length || !labels.every((label) => resolveCitation(report, unit, label)))
          return <Fragment key={index}>{text}</Fragment>;
        return (
          <Fragment key={index}>
            {labels.map((label, offset) => (
              <Fragment key={label}>
                {offset ? '、' : null}
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto px-1 py-0 align-baseline"
                  aria-label={`查看证据 ${label}`}
                  onClick={() => onEvidence({ unit, label })}
                >
                  {label}
                </Button>
              </Fragment>
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}

function SourceValue({ source }: { source: ReviewSource }) {
  const value = source.value;
  if (value === null || value === undefined)
    return <p className="text-sm text-muted-foreground">此项未记录内容。</p>;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.line === 'string' || typeof record.text === 'string')
      return (
        <div className="flex flex-col gap-2 text-sm leading-7">
          {typeof record.title === 'string' ? (
            <h3 className="font-medium">{record.title}</h3>
          ) : null}
          {typeof record.day === 'number' ? <p>第 {record.day} 天</p> : null}
          <p className="whitespace-pre-wrap break-words">{String(record.line ?? record.text)}</p>
        </div>
      );
  }
  return (
    <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7">
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function ReviewEvidence({
  report,
  selection,
  onClose,
}: {
  report: ReviewReport;
  selection: EvidenceSelection;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<EvidenceSelection[]>([selection]);
  const current = history[history.length - 1];
  const resolved = resolveCitation(report, current.unit, current.label);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            证据 {current.label} · {resolved ? sourceTitle(resolved.source) : '引用未找到'}
          </DialogTitle>
          <DialogDescription>
            {current.unit.step === 'review_outcome'
              ? '赛后全知材料，可能包含当时未公开的信息。'
              : '玩家当时视角：仅对应这次决策的冻结材料。'}
          </DialogDescription>
        </DialogHeader>
        {history.length > 1 ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setHistory((items) => items.slice(0, -1))}
          >
            返回上一条引用
          </Button>
        ) : null}
        {resolved?.decision ? (
          <div className="flex flex-col gap-4">
            <h3 className="font-medium">对应决策分析</h3>
            <ReviewAnalysis
              report={report}
              unit={resolved.decision}
              onEvidence={(next) => setHistory((items) => [...items, next])}
            />
            <h3 className="font-medium">这次决策的原始证据</h3>
            <div className="flex flex-wrap gap-2">
              {resolved.decision.sources.map((source, index) => (
                <Button
                  key={source.id}
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setHistory((items) => [
                      ...items,
                      { unit: resolved.decision!, label: `E${index + 1}` },
                    ])
                  }
                >
                  E{index + 1} · {sourceTitle(source)}
                </Button>
              ))}
            </div>
          </div>
        ) : resolved ? (
          <SourceValue source={resolved.source} />
        ) : (
          <p role="alert">报告中没有这条引用对应的证据。</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
