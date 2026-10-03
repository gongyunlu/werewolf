import {
  ExperienceReviewRequestSchema,
  type AgentExperience,
  type ExperienceAudit,
} from '@werewolf/shared';
import { useEffect, useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from './ui/field';
import { Textarea } from './ui/textarea';
import { fetchExperienceAudit, reviewExperience } from '@/lib/experience-api';
import { errorMessage } from '@/lib/http';
import { actionTypeName } from '@/lib/labels';

export function ExperienceReviewPanel({
  item,
  busy,
  change,
  onClose,
}: {
  item: AgentExperience;
  busy: boolean;
  change: (work: () => Promise<{ experiences: AgentExperience[] }>) => Promise<boolean>;
  onClose: () => void;
}) {
  const [audit, setAudit] = useState<ExperienceAudit | null>(null);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetchExperienceAudit(item.agentId, item.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setAudit(value);
        return undefined;
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => controller.abort();
  }, [item.agentId, item.id]);
  const save = async (decision: 'approved' | 'rejected') => {
    if (!audit) return;
    const parsed = ExperienceReviewRequestSchema.safeParse({
      revision: item.revision ?? 0,
      version: item.version,
      decision,
      note,
      sourceIds,
    });
    setInvalid(!parsed.success);
    if (
      parsed.success &&
      (await change(() => reviewExperience(item.agentId, item.id, parsed.data)))
    )
      onClose();
  };
  return (
    <section aria-label="经验审核" className="flex flex-col gap-4">
      <h3 className="font-medium">核对 v{item.version} 的证据与适用范围</h3>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {!audit && !error ? <p>读取证据与相关经验…</p> : null}
      {audit ? (
        <>
          <FieldSet disabled={busy}>
            <FieldLegend>审核依据</FieldLegend>
            <FieldDescription>
              勾选支撑此次结论的原始证据；赛后材料不能当成玩家当时已知。
            </FieldDescription>
            <FieldGroup>
              {audit.sources.map((source, index) => (
                <Field key={source.id} data-invalid={invalid && !sourceIds.length}>
                  <Field orientation="horizontal">
                    <Checkbox
                      id={`${item.id}-source-${index}`}
                      checked={sourceIds.includes(source.id)}
                      aria-invalid={invalid && !sourceIds.length}
                      onCheckedChange={(checked) =>
                        setSourceIds((previous) =>
                          checked
                            ? [...previous, source.id]
                            : previous.filter((id) => id !== source.id),
                        )
                      }
                    />
                    <FieldLabel htmlFor={`${item.id}-source-${index}`}>
                      证据 {index + 1} ·{' '}
                      {source.perspective === 'at_action' ? '对应行动当时' : '赛后材料'}
                    </FieldLabel>
                  </Field>
                  <pre className="whitespace-pre-wrap wrap-anywhere text-xs">
                    {JSON.stringify(source.value, null, 2)}
                  </pre>
                  <FieldDescription className="wrap-anywhere">{source.id}</FieldDescription>
                </Field>
              ))}
            </FieldGroup>
          </FieldSet>
          <div className="flex flex-col gap-3">
            <h4 className="text-sm font-medium">重复与适用范围核对</h4>
            <p className="text-xs text-muted-foreground">
              范围重叠不代表矛盾。请检查不同条件下的建议能否并存，在审核说明中记录判断。
            </p>
            {audit.related.length ? (
              audit.related.map(({ experience, reason }) => (
                <div key={experience.id} className="flex flex-col gap-1 text-sm">
                  <p>
                    <Badge variant="outline">
                      {reason === 'duplicate' ? '正文与条件重复' : '范围重叠，需核对'}
                    </Badge>{' '}
                    {experience.title} · v{experience.version}
                  </p>
                  <p>{experience.body}</p>
                  <p className="text-muted-foreground">
                    适用：{experience.conditions}；排除：{experience.exclusions ?? '尚未填写'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {experience.actionTypes?.map(actionTypeName).join('、') ?? '行动范围待填写'} ·
                    来源 {experience.sourceGameId}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                没有同板子、角色下范围重叠的其他经验。
              </p>
            )}
          </div>
          <Field data-invalid={invalid && !note.trim()}>
            <FieldLabel htmlFor={`review-note-${item.id}`}>审核说明</FieldLabel>
            <Textarea
              id={`review-note-${item.id}`}
              required
              maxLength={600}
              value={note}
              disabled={busy}
              aria-invalid={invalid && !note.trim()}
              onChange={(event) => setNote(event.target.value)}
            />
            <FieldDescription>
              说明证据如何支撑条件与做法，以及重复、冲突或反例的处理理由。审核通过不等于已验证对局收益。
            </FieldDescription>
          </Field>
          {invalid ? <p role="alert">请填写审核说明，并选择至少一项原始证据。</p> : null}
        </>
      ) : null}
      <Field orientation="horizontal">
        <Button disabled={busy || !audit} onClick={() => void save('approved')}>
          审核通过，保持停用
        </Button>
        <Button variant="outline" disabled={busy || !audit} onClick={() => void save('rejected')}>
          不通过并停用
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          取消审核
        </Button>
      </Field>
    </section>
  );
}
