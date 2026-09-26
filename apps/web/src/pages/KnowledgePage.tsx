import {
  KNOWLEDGE_KINDS,
  type BoardSummary,
  type KnowledgeCalls,
  type KnowledgeItem,
  type KnowledgeVersion,
} from '@werewolf/shared';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KnowledgeCard } from '@/components/KnowledgeCard';
import { KnowledgeEditor } from '@/components/KnowledgeEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fetchBoards } from '@/lib/api-client';
import { errorMessage, isCanceled } from '@/lib/http';
import {
  activateKnowledge,
  fetchKnowledge,
  fetchKnowledgeCalls,
  indexKnowledge,
} from '@/lib/knowledge-api';
import { roleName } from '@/lib/labels';

const STATUS: Record<KnowledgeVersion['status'], string> = {
  draft: '草稿',
  pending: '索引待完成',
  ready: '已索引',
  failed: '索引失败',
  unknown: '请求结果未知',
};

function Calls({ versionId }: { versionId: string }) {
  const [data, setData] = useState<KnowledgeCalls | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    try {
      setData(await fetchKnowledgeCalls(versionId));
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  return (
    <details
      className="text-xs text-muted-foreground"
      onToggle={(event) => {
        if (event.currentTarget.open && !data) void load();
      }}
    >
      <summary>索引调用记录</summary>
      <Button size="sm" variant="ghost" onClick={() => void load()}>
        刷新调用记录
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {data?.calls.length === 0 ? <p>此版本尚无调用；查看内容与保存草稿不调用模型。</p> : null}
      {data?.calls.map((call, i) => (
        <div key={call.callId ?? i} className="mb-3 wrap-anywhere">
          <p>
            调用 {call.callId} · {call.model} · {call.status ?? '处理中'}
          </p>
          {call.attempts.map((a) => (
            <p key={a.attemptNo}>
              请求 {a.attemptNo} · {a.status} · {a.dispatched ? '已发送' : '未确认发送'} · 用量：
              {a.usage ? JSON.stringify(a.usage) : '未返回（非零用量）'}
            </p>
          ))}
        </div>
      ))}
    </details>
  );
}

export function KnowledgePage() {
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ item: KnowledgeItem | null } | null>(null);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [state, setState] = useState('all');
  const item =
    items.find((row) => row.id === params.get('id')) ?? (params.has('id') ? undefined : items[0]);
  const version =
    item?.versions.find((v) => v.versionId === params.get('version')) ?? item?.versions.at(-1);
  const visible = items.filter((row) => {
    const c = row.versions.at(-1)!.content;
    return (
      (kind === 'all' || c.kind === kind) &&
      (state === 'all' ||
        (state === 'active' ? row.activeVersionId !== null : row.activeVersionId === null)) &&
      [
        c.title,
        c.body,
        ...c.boardIds,
        ...c.roles.map(roleName),
        ...c.sources.map((s) => `${s.publisher} ${s.title}`),
      ]
        .join(' ')
        .toLowerCase()
        .includes(search.toLowerCase())
    );
  });
  async function load() {
    setItems((await fetchKnowledge()).items);
  }
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([fetchKnowledge(controller.signal), fetchBoards()])
      .then(([data, boardData]) => {
        if (!controller.signal.aborted) {
          setItems(data.items);
          setBoards(boardData.boards);
        }
        return undefined;
      })
      .catch((failure: unknown) => {
        if (!isCanceled(failure)) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  const pending = items.some((row) => row.versions.some((v) => v.status === 'pending'));
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void fetchKnowledge(controller.signal)
        .then((data) => setItems(data.items))
        .catch((failure: unknown) => {
          if (!isCanceled(failure)) setError(errorMessage(failure));
        });
    }, 3000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [pending]);
  const replace = (row: KnowledgeItem) =>
    setItems((rows) =>
      rows.some((r) => r.id === row.id)
        ? rows.map((r) => (r.id === row.id ? row : r))
        : [row, ...rows],
    );
  async function act(work: () => Promise<KnowledgeItem | void>) {
    setBusy(true);
    setError(null);
    try {
      const row = await work();
      if (row) replace(row);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const kindItems = [
    { value: 'all', label: '全部类型' },
    ...Object.entries(KNOWLEDGE_KINDS).map(([value, label]) => ({ value, label })),
  ];
  const stateItems = [
    { value: 'all', label: '全部状态' },
    { value: 'active', label: '已启用' },
    { value: 'inactive', label: '未启用' },
  ];
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">攻略知识库</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            整理资料、核对来源与适用范围，再选择策略供行动参考。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void act(load)}>
            刷新
          </Button>
          <Button disabled={loading} onClick={() => setEditor({ item: null })}>
            新建知识
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        规则参考与案例仅供查阅。策略索引完成后仍需启用；资料不能覆盖当前规则、合法操作和实际证据。
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_10rem]">
        <Field>
          <FieldLabel htmlFor="knowledge-search">搜索标题、角色或来源</FieldLabel>
          <Input
            id="knowledge-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="kind-filter">类型</FieldLabel>
          <Select
            items={kindItems}
            value={kind}
            onValueChange={(v) => {
              if (v) setKind(v);
            }}
          >
            <SelectTrigger id="kind-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {kindItems.map((v) => (
                <SelectItem key={v.value} value={v.value}>
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="state-filter">启用状态</FieldLabel>
          <Select
            items={stateItems}
            value={state}
            onValueChange={(v) => {
              if (v) setState(v);
            }}
          >
            <SelectTrigger id="state-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {stateItems.map((v) => (
                <SelectItem key={v.value} value={v.value}>
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {loading ? (
        <output>正在读取知识…</output>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[20rem_1fr]">
          <nav aria-label="知识条目" className="flex flex-col gap-2">
            {visible.length === 0 ? (
              <p className="text-sm text-muted-foreground">没有符合条件的知识。</p>
            ) : (
              visible.map((row) => {
                const latest = row.versions.at(-1)!;
                return (
                  <Button
                    key={row.id}
                    variant={row.id === item?.id ? 'secondary' : 'outline'}
                    className="h-auto justify-start py-3 text-left whitespace-normal"
                    onClick={() => setParams({ id: row.id })}
                  >
                    <span className="flex flex-col gap-1">
                      <span>{latest.content.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {KNOWLEDGE_KINDS[latest.content.kind]} · {STATUS[latest.status]} ·{' '}
                        {row.activeVersionId ? '已启用' : '未启用'}
                      </span>
                    </span>
                  </Button>
                );
              })
            )}
          </nav>
          {item && version ? (
            <section aria-label="知识详情" className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  items={item.versions.map((v) => ({
                    value: v.versionId,
                    label: `v${v.version} · ${STATUS[v.status]}${item.activeVersionId === v.versionId ? ' · 当前启用' : ''}`,
                  }))}
                  value={version.versionId}
                  onValueChange={(v) => {
                    if (v) setParams({ id: item.id, version: v });
                  }}
                >
                  <SelectTrigger aria-label="知识版本" className="w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {item.versions.map((v) => (
                      <SelectItem key={v.versionId} value={v.versionId}>
                        v{v.version} · {STATUS[v.status]}
                        {item.activeVersionId === v.versionId ? ' · 当前启用' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Badge variant="outline">
                  {item.activeVersionId === version.versionId ? '此版本已启用' : '此版本未启用'}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setEditor({ item })}
                >
                  编辑最新内容
                </Button>
              </div>
              <KnowledgeCard knowledge={version} />
              <p className="text-xs text-muted-foreground">
                创建：{new Date(version.createdAt).toLocaleString()} · 向量型号：
                {version.model ?? '尚未索引'}
              </p>
              {version.failure ? (
                <p role="alert" className="text-sm text-destructive">
                  {version.failure}
                </p>
              ) : null}
              {version.content.kind === 'strategy' ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={busy || version.status === 'unknown'}
                    onClick={() => void act(() => indexKnowledge(version.versionId))}
                  >
                    {version.status === 'draft' ? '建立索引（调用向量模型）' : '检查或继续索引'}
                  </Button>
                  {version.status === 'ready' && item.activeVersionId !== version.versionId ? (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void act(() => activateKnowledge(item.id, item.revision, version.versionId))
                      }
                    >
                      启用此版本
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {item.activeVersionId ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void act(() => activateKnowledge(item.id, item.revision, null))}
                >
                  停用此知识
                </Button>
              ) : null}
              <Calls key={version.versionId} versionId={version.versionId} />
            </section>
          ) : (
            <p className="text-sm text-muted-foreground">
              {params.has('id') ? '没有找到这条知识。' : '新建知识后即可在此查看和管理。'}
            </p>
          )}
        </div>
      )}
      {editor ? (
        <KnowledgeEditor
          item={editor.item}
          boards={boards}
          onClose={() => setEditor(null)}
          onSaved={(row) => {
            replace(row);
            setParams({ id: row.id });
            setEditor(null);
          }}
        />
      ) : null}
    </main>
  );
}
