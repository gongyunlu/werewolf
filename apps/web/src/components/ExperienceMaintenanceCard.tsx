import {
  ExperienceEditableSchema,
  KNOWLEDGE_ACTION_TYPES,
  type AgentExperience,
} from '@werewolf/shared';
import { useState } from 'react';
import { ExperienceCard } from './ExperienceCard';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldSet, FieldLegend } from './ui/field';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Checkbox } from './ui/checkbox';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { ExperienceReviewPanel } from './ExperienceReviewPanel';
import { actionTypeName } from '@/lib/labels';
import {
  archiveExperience,
  editExperience,
  indexExperience,
  toggleExperience,
} from '@/lib/experience-api';

type Change = (work: () => Promise<{ experiences: AgentExperience[] }>) => Promise<boolean>;
const indexLabels = {
  draft: '待建立向量索引',
  pending: '索引待完成',
  ready: '索引已就绪',
  failed: '索引失败',
  unknown: '索引结果未知',
};
const editable = (item: AgentExperience) => ({
  title: item.title,
  body: item.body,
  conditions: item.conditions,
  actionTypes: item.actionTypes ?? [],
  minDay: item.minDay ?? '',
  firstDayOnly: item.firstDayOnly,
  exclusions: item.exclusions ?? '',
});

export function ExperienceMaintenanceCard({
  item,
  busy,
  change,
}: {
  item: AgentExperience;
  busy: boolean;
  change: Change;
}) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [draft, setDraft] = useState(() => editable(item));
  const [invalid, setInvalid] = useState(false);
  const status = item.indexStatus ?? (item.indexed ? 'ready' : 'draft');
  const revision = item.revision ?? 0;
  const lastReview = item.reviews?.at(-1);
  const approved = lastReview?.version === item.version && lastReview.decision === 'approved';
  const save = async () => {
    const parsed = ExperienceEditableSchema.safeParse(draft);
    setInvalid(!parsed.success);
    if (!parsed.success) return;
    if (await change(() => editExperience(item.agentId, item.id, revision, parsed.data)))
      setEditing(false);
  };
  return (
    <div className="flex flex-col gap-3">
      <ExperienceCard experience={item}>
        <Badge variant={item.enabled ? 'secondary' : 'outline'}>
          {item.archived ? '已归档' : item.enabled ? '已启用' : '已停用'}
        </Badge>
        <Badge variant="outline">{indexLabels[status]}</Badge>
        <Badge variant="outline">
          {lastReview?.version !== item.version
            ? '待审核候选'
            : approved
              ? '审核通过'
              : '审核未通过'}
        </Badge>
        {item.archived ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void change(() => archiveExperience(item.agentId, item.id, revision, false))
            }
          >
            恢复为停用
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy || editing || reviewing || (!item.enabled && (status !== 'ready' || !approved))
              }
              onClick={() =>
                void change(() => toggleExperience(item.agentId, item.id, !item.enabled, revision))
              }
            >
              {item.enabled ? '停用经验' : '重新启用'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || editing || reviewing}
              onClick={() => {
                setDraft(editable(item));
                setInvalid(false);
                setEditing(true);
              }}
            >
              编辑经验
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || editing || reviewing}
              onClick={() => setReviewing(true)}
            >
              审核经验
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                editing ||
                reviewing ||
                status === 'unknown' ||
                (item.enabled && status === 'ready')
              }
              onClick={() =>
                void change(() => indexExperience(item.agentId, item.id, item.version))
              }
            >
              {status === 'ready' ? '重建索引' : status === 'draft' ? '建立索引' : '继续索引'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || editing || reviewing}
              onClick={() =>
                void change(() => archiveExperience(item.agentId, item.id, revision, true))
              }
            >
              归档经验
            </Button>
          </>
        )}
        {item.history?.length ? (
          <Button size="sm" variant="ghost" onClick={() => setHistory(!history)}>
            {history ? '收起历史版本' : '历史版本'}
          </Button>
        ) : null}
        {item.indexModel ? (
          <p className="w-full text-xs text-muted-foreground">索引型号：{item.indexModel}</p>
        ) : null}
        {item.indexFailure ? (
          <p role="alert" className="w-full text-sm text-destructive">
            {item.indexFailure}
          </p>
        ) : null}
        {item.indexCalls?.map((call) => (
          <p key={call.callId} className="w-full text-xs text-muted-foreground">
            索引调用 {call.callId} · {call.status}
          </p>
        ))}
      </ExperienceCard>
      {reviewing ? (
        <ExperienceReviewPanel
          item={item}
          busy={busy}
          change={change}
          onClose={() => setReviewing(false)}
        />
      ) : null}
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <FieldGroup>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor={`title-${item.id}`}>标题</FieldLabel>
              <Input
                id={`title-${item.id}`}
                required
                maxLength={64}
                disabled={busy}
                value={draft.title}
                aria-invalid={invalid}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </Field>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor={`body-${item.id}`}>正文</FieldLabel>
              <Textarea
                id={`body-${item.id}`}
                required
                maxLength={600}
                rows={5}
                disabled={busy}
                value={draft.body}
                aria-invalid={invalid}
                onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              />
            </Field>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor={`conditions-${item.id}`}>适用条件</FieldLabel>
              <Textarea
                id={`conditions-${item.id}`}
                required
                maxLength={240}
                disabled={busy}
                value={draft.conditions}
                aria-invalid={invalid}
                onChange={(event) => setDraft({ ...draft, conditions: event.target.value })}
              />
              <FieldDescription>
                保存修改会建立新版本并停用，需要重新审核、建立索引后再手动启用。
              </FieldDescription>
            </Field>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor={`exclusions-${item.id}`}>不适用条件</FieldLabel>
              <Textarea
                id={`exclusions-${item.id}`}
                required
                maxLength={240}
                disabled={busy}
                value={draft.exclusions}
                aria-invalid={invalid}
                onChange={(event) => setDraft({ ...draft, exclusions: event.target.value })}
              />
            </Field>
            <FieldSet disabled={busy}>
              <FieldLegend>适用行动</FieldLegend>
              <FieldDescription>仅选择有证据支持的行动，最多 12 项。</FieldDescription>
              <FieldGroup className="grid grid-cols-2">
                {KNOWLEDGE_ACTION_TYPES.map((type) => (
                  <Field
                    key={type}
                    orientation="horizontal"
                    data-invalid={invalid && !draft.actionTypes.length}
                  >
                    <Checkbox
                      id={`${item.id}-${type}`}
                      checked={draft.actionTypes.includes(type)}
                      aria-invalid={invalid && !draft.actionTypes.length}
                      onCheckedChange={(checked) =>
                        setDraft({
                          ...draft,
                          actionTypes: checked
                            ? [...draft.actionTypes, type]
                            : draft.actionTypes.filter((value) => value !== type),
                        })
                      }
                    />
                    <FieldLabel htmlFor={`${item.id}-${type}`}>{actionTypeName(type)}</FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
            </FieldSet>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor={`day-${item.id}`}>最早适用天数</FieldLabel>
              <Input
                id={`day-${item.id}`}
                type="number"
                min={1}
                max={20}
                required
                disabled={busy}
                value={draft.minDay}
                aria-invalid={invalid}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    minDay: event.target.value === '' ? '' : Number(event.target.value),
                  })
                }
              />
            </Field>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor={`first-day-${item.id}`}>适用日期范围</FieldLabel>
              <Select
                value={draft.firstDayOnly === undefined ? null : String(draft.firstDayOnly)}
                disabled={busy}
                onValueChange={(value) =>
                  setDraft({
                    ...draft,
                    firstDayOnly: value === null ? undefined : value === 'true',
                  })
                }
              >
                <SelectTrigger id={`first-day-${item.id}`} aria-invalid={invalid}>
                  <SelectValue placeholder="请选择日期范围" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="false">最早天数之后均可</SelectItem>
                    <SelectItem value="true">仅第 1 天</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {invalid ? (
              <p role="alert">请补齐正文、条件与适用范围；仅首日时最早天数必须为 1。</p>
            ) : null}
            <Field orientation="horizontal">
              <Button type="submit" disabled={busy}>
                保存新版本
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                取消编辑
              </Button>
            </Field>
          </FieldGroup>
        </form>
      ) : null}
      {item.reviews?.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer">审核记录（{item.reviews.length}）</summary>
          <div className="flex flex-col gap-3 pt-3">
            {item.reviews.map((review, index) => (
              <div key={`${review.reviewedAt}/${index}`} className="flex flex-col gap-1">
                <p>
                  v{review.version} · {review.decision === 'approved' ? '通过' : '未通过'} ·{' '}
                  {review.reviewedAt}
                </p>
                <p className="whitespace-pre-wrap">{review.note}</p>
                <p className="text-xs text-muted-foreground wrap-anywhere">
                  依据：{review.sourceIds.join('、')}
                </p>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {history
        ? item.history?.map((snapshot) => (
            <ExperienceCard key={snapshot.version} experience={snapshot}>
              <Badge variant="outline">历史版本 · 仅供查阅</Badge>
            </ExperienceCard>
          ))
        : null}
    </div>
  );
}
