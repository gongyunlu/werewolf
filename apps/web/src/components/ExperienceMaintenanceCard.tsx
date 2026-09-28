import { ExperienceEditableSchema, type AgentExperience } from '@werewolf/shared';
import { useState } from 'react';
import { ExperienceCard } from './ExperienceCard';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Field, FieldGroup, FieldLabel, FieldDescription } from './ui/field';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
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
  const [draft, setDraft] = useState({
    title: item.title,
    body: item.body,
    conditions: item.conditions,
  });
  const [invalid, setInvalid] = useState(false);
  const status = item.indexStatus ?? (item.indexed ? 'ready' : 'draft');
  const revision = item.revision ?? 0;
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
                busy || editing || (!item.enabled && item.version > 1 && status !== 'ready')
              }
              onClick={() =>
                void change(() =>
                  toggleExperience(item.agentId, item.id, !item.enabled, item.revision),
                )
              }
            >
              {item.enabled ? '停用经验' : '重新启用'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || editing}
              onClick={() => {
                setDraft({ title: item.title, body: item.body, conditions: item.conditions });
                setInvalid(false);
                setEditing(true);
              }}
            >
              编辑经验
            </Button>
            {item.version > 1 || !item.indexed ? (
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy || editing || status === 'unknown' || (item.enabled && status === 'ready')
                }
                onClick={() =>
                  void change(() => indexExperience(item.agentId, item.id, item.version))
                }
              >
                {status === 'ready' ? '重建索引' : status === 'draft' ? '建立索引' : '继续索引'}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || editing}
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
                保存修改会建立新版本并停用。需显式建立索引、重新启用才参与后续行动；归属、板子、角色和证据引用保持不变。
              </FieldDescription>
            </Field>
            {invalid ? <p role="alert">请填写有效标题、正文和适用条件，不能只含空白。</p> : null}
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
