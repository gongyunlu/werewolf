import {
  KNOWLEDGE_ACTION_TYPES,
  KNOWLEDGE_KINDS,
  KnowledgeContentSchema,
  type BoardSummary,
  type KnowledgeContent,
  type KnowledgeItem,
} from '@werewolf/shared';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/http';
import { saveKnowledge } from '@/lib/knowledge-api';
import { actionTypeName, roleName } from '@/lib/labels';

const ROLES = [
  'villager',
  'seer',
  'witch',
  'hunter',
  'guard',
  'werewolf',
  'wolf_king',
  'white_wolf',
] as const;
const emptySource = (): KnowledgeContent['sources'][number] => ({
  title: '',
  url: '',
  publisher: '',
  author: '',
  locator: '',
  publishedOn: null,
  checkedOn: new Date().toLocaleDateString('en-CA'),
});
const emptyContent = (): KnowledgeContent => ({
  kind: 'strategy',
  title: '',
  body: '',
  conditions: '',
  adaptation: '',
  rulesBasis: '',
  boardIds: [],
  roles: [],
  actionTypes: [],
  firstDayOnly: false,
  minDay: 1,
  sources: [emptySource()],
});

function TextField({
  label,
  value,
  onChange,
  max,
  multiline = false,
  type = 'text',
  required = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  max?: number;
  multiline?: boolean;
  type?: string;
  required?: boolean;
}) {
  const id = useId();
  const props = {
    id,
    value,
    required,
    maxLength: max,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(event.target.value),
  };
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {multiline ? <Textarea {...props} rows={3} /> : <Input {...props} type={type} />}
    </Field>
  );
}

function Choices<T extends string>({
  title,
  choices,
  selected,
  onChange,
}: {
  title: string;
  choices: { value: T; label: string }[];
  selected: T[];
  onChange: (value: T[]) => void;
}) {
  const id = useId();
  return (
    <FieldSet>
      <FieldLegend>{title}</FieldLegend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {choices.map((choice) => (
          <Field key={choice.value} orientation="horizontal" className="w-auto">
            <Checkbox
              id={`${id}-${choice.value}`}
              checked={selected.includes(choice.value)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...selected, choice.value]
                    : selected.filter((v) => v !== choice.value),
                )
              }
            />
            <FieldLabel htmlFor={`${id}-${choice.value}`}>{choice.label}</FieldLabel>
          </Field>
        ))}
      </div>
    </FieldSet>
  );
}

export function KnowledgeEditor({
  item,
  boards,
  onClose,
  onSaved,
}: {
  item: KnowledgeItem | null;
  boards: BoardSummary[];
  onClose: () => void;
  onSaved: (row: KnowledgeItem) => void;
}) {
  const [id] = useState(() => item?.id ?? crypto.randomUUID());
  const [content, setContent] = useState(() =>
    structuredClone(item?.versions.at(-1)?.content ?? emptyContent()),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = <K extends keyof KnowledgeContent>(key: K, value: KnowledgeContent[K]) =>
    setContent((c) => ({ ...c, [key]: value }));
  const kinds = Object.entries(KNOWLEDGE_KINDS).map(([value, label]) => ({ value, label }));
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = KnowledgeContentSchema.safeParse(content);
    if (!parsed.success) {
      setError(
        parsed.error.issues.map((issue) => `${issue.path.join('.')}：${issue.message}`).join('；'),
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveKnowledge(id, item?.revision ?? 0, parsed.data));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item ? '编辑知识' : '新建知识'}</DialogTitle>
          <DialogDescription>
            保存草稿不会调用模型。已开始索引的版本保留原文，修改后产生新版本，需另行索引并启用。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="knowledge-kind">内容类型</FieldLabel>
              <Select
                items={kinds}
                value={content.kind}
                onValueChange={(v) => {
                  if (v) update('kind', v as KnowledgeContent['kind']);
                }}
              >
                <SelectTrigger id="knowledge-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {kinds.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <TextField
              label="标题"
              value={content.title}
              max={64}
              onChange={(v) => update('title', v)}
            />
            <TextField
              label="整理正文"
              value={content.body}
              max={600}
              multiline
              onChange={(v) => update('body', v)}
            />
            <TextField
              label="适用条件"
              value={content.conditions}
              max={240}
              multiline
              onChange={(v) => update('conditions', v)}
            />
            <TextField
              label="本局适配与差异"
              value={content.adaptation}
              max={300}
              multiline
              onChange={(v) => update('adaptation', v)}
            />
            <TextField
              label="规则基线"
              value={content.rulesBasis}
              max={160}
              onChange={(v) => update('rulesBasis', v)}
            />
            <Choices
              title="适用板子"
              choices={boards.map((b) => ({ value: b.id, label: b.name }))}
              selected={content.boardIds}
              onChange={(v) => update('boardIds', v)}
            />
            <Choices
              title="适用角色"
              choices={ROLES.map((value) => ({ value, label: roleName(value) }))}
              selected={content.roles}
              onChange={(v) => update('roles', v)}
            />
            <Choices
              title="适用行动（最多12项）"
              choices={KNOWLEDGE_ACTION_TYPES.map((value) => ({
                value,
                label: actionTypeName(value),
              }))}
              selected={content.actionTypes}
              onChange={(v) => update('actionTypes', v)}
            />
            <TextField
              label="最早适用天数（1—20）"
              type="number"
              value={String(content.minDay)}
              onChange={(v) => update('minDay', Number(v))}
            />
            <Field orientation="horizontal">
              <Checkbox
                id="knowledge-first-day"
                checked={content.firstDayOnly}
                onCheckedChange={(v) => update('firstDayOnly', v === true)}
              />
              <FieldLabel htmlFor="knowledge-first-day">仅第1天可检索</FieldLabel>
            </Field>
          </FieldGroup>
          {content.sources.map((source, i) => {
            const change = (key: keyof typeof source, value: string | null) =>
              update(
                'sources',
                content.sources.map((s, j) => (j === i ? { ...s, [key]: value } : s)),
              );
            return (
              <FieldSet key={i}>
                <FieldLegend>来源 {i + 1}</FieldLegend>
                <FieldGroup className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label={`来源${i + 1}标题`}
                    value={source.title}
                    max={160}
                    onChange={(v) => change('title', v)}
                  />
                  <TextField
                    label={`来源${i + 1}链接`}
                    value={source.url}
                    type="url"
                    max={600}
                    onChange={(v) => change('url', v)}
                  />
                  <TextField
                    label="发布者"
                    value={source.publisher}
                    max={80}
                    onChange={(v) => change('publisher', v)}
                  />
                  <TextField
                    label="作者（可空）"
                    value={source.author}
                    required={false}
                    max={80}
                    onChange={(v) => change('author', v)}
                  />
                  <TextField
                    label="小节或定位说明"
                    value={source.locator}
                    max={160}
                    onChange={(v) => change('locator', v)}
                  />
                  <TextField
                    label="发布日期（未知可空）"
                    value={source.publishedOn ?? ''}
                    type="date"
                    required={false}
                    onChange={(v) => change('publishedOn', v || null)}
                  />
                  <TextField
                    label="人工核对日期"
                    value={source.checkedOn}
                    type="date"
                    onChange={(v) => change('checkedOn', v)}
                  />
                </FieldGroup>
                {content.sources.length > 1 ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      update(
                        'sources',
                        content.sources.filter((_, j) => j !== i),
                      )
                    }
                  >
                    移除此来源
                  </Button>
                ) : null}
              </FieldSet>
            );
          })}
          {content.sources.length < 3 ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => update('sources', [...content.sources, emptySource()])}
            >
              添加来源
            </Button>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? '保存中…' : '保存草稿'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
