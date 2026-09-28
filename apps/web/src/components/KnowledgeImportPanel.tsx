import type {
  BoardSummary,
  KnowledgeCandidate,
  KnowledgeCapture,
  KnowledgeContent,
  KnowledgeItem,
  WebSnapshot,
} from '@werewolf/shared';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, isCanceled } from '@/lib/http';
import { fetchKnowledge } from '@/lib/knowledge-api';
import {
  bulkKnowledgeAction,
  confirmCandidate,
  discardCandidate,
  fetchCapture,
  fetchCaptureCalls,
  fetchCaptures,
  fetchImportModel,
  organizeCapture,
  retryCapture,
  startCapture,
} from '@/lib/knowledge-import-api';
import { KnowledgeCard } from './KnowledgeCard';
import { KnowledgeChanges } from './KnowledgeChanges';
import { KnowledgeEditor } from './KnowledgeEditor';

const STATUS = {
  queued: '等待采集',
  fetching: '采集中',
  ready: '已采集',
  unchanged: '正文未变',
  failed: '采集失败',
};
const ORGANIZATION = {
  queued: '等待整理',
  running: '整理中',
  ready: '已整理',
  failed: '整理失败',
  unknown: '请求结果未知',
};

function Choice({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal" className="items-start">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <FieldLabel htmlFor={id} className="whitespace-pre-wrap font-normal">
        {children}
      </FieldLabel>
    </Field>
  );
}
const toggle = (values: string[], value: string, checked: boolean) =>
  checked ? [...values, value] : values.filter((v) => v !== value);

function SourceChanges({ previousId, snapshot }: { previousId: string; snapshot: WebSnapshot }) {
  const [previous, setPrevious] = useState<WebSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    try {
      setPrevious((await fetchCapture(previousId)).snapshot);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  const removed =
    previous?.paragraphs.filter((p) => !snapshot.paragraphs.some((s) => s.text === p.text)) ?? [];
  const added = previous
    ? snapshot.paragraphs.filter((p) => !previous.paragraphs.some((s) => s.text === p.text))
    : [];
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !previous) void load();
      }}
    >
      <summary>与上次采集比较</summary>
      <Link className="underline" to={`/knowledge/sources/${previousId}`} target="_blank">
        查看上次正文快照
      </Link>
      {error ? <p role="alert">{error}</p> : null}
      {previous ? (
        <div className="mt-2 space-y-2 text-sm">
          <p>
            标题：{previous.title} → {snapshot.title}
          </p>
          <p>
            作者：{previous.author || '未标明'} → {snapshot.author || '未标明'}；发布日期：
            {previous.publishedOn || '未标明'} → {snapshot.publishedOn || '未标明'}
          </p>
          <p>
            删除或修改 {removed.length} 段，新增或修改 {added.length} 段。段落顺序请对照完整快照。
          </p>
          {removed.map((p) => (
            <p key={`old-${p.id}`} className="border-l-2 pl-3 text-muted-foreground">
              原 {p.id}：{p.text}
            </p>
          ))}
          {added.map((p) => (
            <p key={`new-${p.id}`} className="border-l-2 border-primary pl-3">
              新 {p.id}：{p.text}
            </p>
          ))}
        </div>
      ) : null}
    </details>
  );
}

function CaptureDetail({
  row,
  boards,
  items,
  model,
  busy,
  run,
  onKnowledgeChanged,
  onRecapture,
}: {
  row: KnowledgeCapture;
  boards: BoardSummary[];
  items: KnowledgeItem[];
  model: string;
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
  onKnowledgeChanged: () => Promise<void>;
  onRecapture: (url: string) => Promise<void>;
}) {
  const [boardIds, setBoardIds] = useState<string[]>([]);
  const [paragraphIds, setParagraphIds] = useState<string[]>([]);
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<Record<string, string | null>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{
    candidate: KnowledgeCandidate;
    before: KnowledgeContent | null;
    revision: number;
  } | null>(null);
  const [calls, setCalls] = useState<Awaited<ReturnType<typeof fetchCaptureCalls>> | null>(null);
  const snapshot = row.snapshot;
  const frozen = row.organization;
  const chosenParagraphs = frozen?.paragraphIds ?? paragraphIds;
  const length =
    snapshot?.paragraphs
      .filter((p) => chosenParagraphs.includes(p.id))
      .reduce((n, p) => n + p.text.length, 0) ?? 0;
  const associated = items.filter((item) =>
    item.versions
      .at(-1)!
      .content.sources.some(
        (s) => s.sourceId === row.sourceId || s.url === row.url || s.url === snapshot?.url,
      ),
  );
  const candidates = row.candidates.map((candidate) => {
    const item = items.find((i) => i.id === candidate.itemId);
    const version = item?.versions.find((v) => v.versionId === candidate.versionId);
    const content = version?.content ?? candidate.content;
    return {
      ...candidate,
      content,
      item,
      version,
      checked: selected[candidate.id] === JSON.stringify(content),
    };
  });
  const saved = candidates.filter((c) => c.status === 'saved' && c.version);
  const selectedVersions = saved
    .filter((c) => c.checked)
    .map((c) => ({ id: c.itemId, versionId: c.versionId!, revision: c.item!.revision }));
  async function saveSelected() {
    const messages: Record<string, string> = {};
    for (const candidate of candidates.filter((c) => c.status === 'pending' && c.checked)) {
      try {
        await confirmCandidate(row.id, candidate.id, candidate.content, candidate.expectedRevision);
        messages[candidate.id] = '已保存草稿';
      } catch (failure) {
        messages[candidate.id] = errorMessage(failure);
      }
    }
    setResults(messages);
    await onKnowledgeChanged();
  }
  async function bulk(operation: 'index' | 'activate') {
    const data = await bulkKnowledgeAction(operation, selectedVersions);
    setResults(
      Object.fromEntries(
        data.results.map((result) => [
          saved.find((c) => c.versionId === result.versionId)!.id,
          result.error ?? (operation === 'index' ? '已受理索引，请查看版本状态' : '已启用此版本'),
        ]),
      ),
    );
    await onKnowledgeChanged();
  }
  return (
    <section aria-label="采集详情" className="min-w-0 space-y-4">
      <div className="space-y-1">
        <h3 className="font-semibold">{snapshot?.title ?? '网页采集'}</h3>
        <a href={row.url} target="_blank" rel="noreferrer" className="break-all text-sm underline">
          {row.url}
        </a>
        <p className="text-sm text-muted-foreground">
          {STATUS[row.status]} · {new Date(row.createdAt).toLocaleString()}
          {frozen ? ` · ${ORGANIZATION[frozen.status]}` : ''}
        </p>
      </div>
      {row.failure ? (
        <p role="alert" className="text-sm text-destructive">
          {row.failure}
        </p>
      ) : null}
      {!snapshot ? (
        <Button
          disabled={busy}
          variant="outline"
          onClick={() => void run(() => retryCapture(row.id))}
        >
          重试或继续采集
        </Button>
      ) : (
        <>
          <div className="flex flex-wrap gap-3 text-sm">
            <Link className="underline" to={`/knowledge/sources/${row.id}`} target="_blank">
              打开正文快照
            </Link>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void onRecapture(row.url)}
            >
              重新采集，检查更新
            </Button>
          </div>
          {row.previousId ? (
            <SourceChanges previousId={row.previousId} snapshot={snapshot} />
          ) : null}
          {row.status === 'unchanged' ? (
            <p className="text-sm text-muted-foreground">
              本次正文和元数据没有变化。没有自动整理或更新知识。
            </p>
          ) : null}
          <div className="space-y-2">
            <p className="font-medium">适用板子</p>
            {boards.map((board) => (
              <Choice
                key={board.id}
                checked={(frozen?.boardIds ?? boardIds).includes(board.id)}
                disabled={busy || !!frozen}
                onChange={(v) => setBoardIds(toggle(boardIds, board.id, v))}
              >
                {board.name}
              </Choice>
            ))}
          </div>
          <details>
            <summary>选择提供给 AI 的正文段落（已选 {length} / 12000 字）</summary>
            <p className="my-2 text-sm text-muted-foreground">
              只发送勾选的段落；请核对是否包含必要的上下文。
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !!frozen}
              onClick={() => {
                let count = 0;
                setParagraphIds(
                  snapshot.paragraphs
                    .filter((p, i) => {
                      count += p.text.length;
                      return count <= 12000 && i < 100;
                    })
                    .map((p) => p.id),
                );
              }}
            >
              选取前 12000 字以内的完整段落
            </Button>
            <div className="mt-3 max-h-96 space-y-3 overflow-y-auto pr-3">
              {snapshot.paragraphs.map((p) => (
                <Choice
                  key={p.id}
                  checked={chosenParagraphs.includes(p.id)}
                  disabled={busy || !!frozen}
                  onChange={(v) => setParagraphIds(toggle(paragraphIds, p.id, v))}
                >
                  {p.id} · {p.text}
                </Choice>
              ))}
            </div>
          </details>
          {associated.length ? (
            <div className="space-y-2">
              <p className="font-medium">需要同步更新的关联知识（可选，最多 5 条）</p>
              <p className="text-sm text-muted-foreground">
                勾选表示提出这些条目的更新草稿。保存后旧启用版本继续生效，直到手动切换。
              </p>
              {associated.map((item) => (
                <Choice
                  key={item.id}
                  checked={(frozen?.targetIds ?? targetIds).includes(item.id)}
                  disabled={busy || !!frozen}
                  onChange={(v) => setTargetIds(toggle(targetIds, item.id, v))}
                >
                  {item.versions.at(-1)!.content.title}
                </Choice>
              ))}
            </div>
          ) : null}
          <p className="text-sm text-muted-foreground">
            整理型号：{frozen?.model ?? model}。每页最多 5
            条候选，也可能没有适用内容。采集、预览和保存不调用模型。
          </p>
          {frozen?.failure ? (
            <p role="alert" className="text-sm text-destructive">
              {frozen.failure}
            </p>
          ) : null}
          {frozen?.status !== 'ready' ? (
            <Button
              disabled={
                busy ||
                !model ||
                frozen?.status === 'unknown' ||
                (!frozen &&
                  (!boardIds.length ||
                    !paragraphIds.length ||
                    length > 12000 ||
                    targetIds.length > 5))
              }
              onClick={() =>
                void run(() =>
                  organizeCapture(row.id, {
                    revision: row.revision,
                    boardIds: frozen?.boardIds ?? boardIds,
                    paragraphIds: chosenParagraphs,
                    targetIds: frozen?.targetIds ?? targetIds,
                  }),
                )
              }
            >
              {frozen ? '继续整理（可能调用模型）' : 'AI 生成草稿（调用模型）'}
            </Button>
          ) : (
            <p className="text-sm">
              整理结果：{frozen.reason} · {row.candidates.length} 条候选
            </p>
          )}
          {frozen ? (
            <details
              onToggle={(e) => {
                if (e.currentTarget.open && !calls)
                  void run(async () => setCalls(await fetchCaptureCalls(row.id)));
              }}
            >
              <summary>整理调用记录</summary>
              {calls?.calls.map((call, i) => (
                <div key={call.callId ?? i} className="my-2 break-all text-xs">
                  <p>
                    {call.callId} · {call.model} · {call.status ?? '处理中'}
                  </p>
                  {call.attempts.map((attempt) => (
                    <p key={attempt.attemptNo}>
                      请求 {attempt.attemptNo} · {attempt.status} · 用量{' '}
                      {attempt.usage ? JSON.stringify(attempt.usage) : '未返回（非零用量）'}
                    </p>
                  ))}
                </div>
              ))}
            </details>
          ) : null}
          {row.candidates.length ? (
            <div className="space-y-4">
              <h4 className="font-semibold">人工确认候选</h4>
              <p className="text-sm text-muted-foreground">
                逐条核对来源、规则和适用范围后勾选。保存仅写入草稿；未确认内容不进入行动检索。
                已保存版本内容变化后需重新核对并勾选。
              </p>
              {candidates.map((candidate) => {
                const { item, version } = candidate;
                return (
                  <article key={candidate.id} className="space-y-3 rounded-lg border p-4">
                    <Choice
                      checked={candidate.checked}
                      disabled={
                        busy ||
                        candidate.status === 'discarded' ||
                        (candidate.status === 'saved' && !version)
                      }
                      onChange={(v) =>
                        setSelected((current) => ({
                          ...current,
                          [candidate.id]: v ? JSON.stringify(candidate.content) : null,
                        }))
                      }
                    >
                      {candidate.status === 'pending'
                        ? '已核对，选中保存'
                        : candidate.status === 'saved'
                          ? '选中此保存版本以索引或启用'
                          : '已丢弃'}{' '}
                      · {candidate.before ? '更新知识' : '新增知识'}
                    </Choice>
                    <KnowledgeCard
                      knowledge={{ content: candidate.content, version: version?.version }}
                    />
                    {candidate.before ? (
                      <KnowledgeChanges before={candidate.before} after={candidate.content} />
                    ) : null}
                    {candidate.status === 'pending' ? (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            setReview({
                              candidate,
                              before: candidate.before,
                              revision: candidate.expectedRevision,
                            })
                          }
                        >
                          编辑并确认
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void run(() => discardCandidate(row.id, candidate.id))}
                        >
                          丢弃候选
                        </Button>
                      </div>
                    ) : null}
                    {version ? (
                      <p className="text-sm">
                        保存为 v{version.version} ·{' '}
                        {
                          {
                            draft: '草稿',
                            pending: '索引中',
                            ready: '已索引',
                            failed: '索引失败',
                            unknown: '索引请求结果未知',
                          }[version.status]
                        }{' '}
                        ·{' '}
                        {item?.activeVersionId === version.versionId
                          ? '此版本已启用'
                          : '此版本未启用'}
                        {version.failure ? `：${version.failure}` : ''}{' '}
                        <Link
                          className="underline"
                          to={`/knowledge?id=${candidate.itemId}&version=${candidate.versionId}`}
                        >
                          管理版本
                        </Link>
                      </p>
                    ) : null}
                    {results[candidate.id] ? (
                      <output className="text-sm">{results[candidate.id]}</output>
                    ) : null}
                  </article>
                );
              })}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || !candidates.some((c) => c.status === 'pending' && c.checked)}
                  onClick={() => void run(saveSelected)}
                >
                  确认并保存选中草稿
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !selectedVersions.length}
                  onClick={() => void run(() => bulk('index'))}
                >
                  选中版本建立索引（调用向量模型）
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !selectedVersions.length}
                  onClick={() => void run(() => bulk('activate'))}
                >
                  启用选中版本
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
      {review ? (
        <KnowledgeEditor
          item={null}
          boards={boards}
          onClose={() => setReview(null)}
          onSaved={() => undefined}
          review={{
            content: review.candidate.content,
            before: review.before,
            onConfirm: async (content) => {
              await confirmCandidate(row.id, review.candidate.id, content, review.revision);
              setReview(null);
              await run(onKnowledgeChanged);
            },
            onRefresh: async () => {
              const latest = (await fetchKnowledge()).items.find(
                (i) => i.id === review.candidate.itemId,
              );
              if (!latest) throw new Error('未找到更新目标');
              setReview((current) =>
                current
                  ? {
                      ...current,
                      before: latest.versions.at(-1)!.content,
                      revision: latest.revision,
                    }
                  : null,
              );
            },
          }}
        />
      ) : null}
    </section>
  );
}

export function KnowledgeImportPanel({
  boards,
  items,
  onKnowledgeChanged,
}: {
  boards: BoardSummary[];
  items: KnowledgeItem[];
  onKnowledgeChanged: () => Promise<void>;
}) {
  const [urls, setUrls] = useState('');
  const [batchId, setBatchId] = useState(() => crypto.randomUUID());
  const [rows, setRows] = useState<KnowledgeCapture[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function refresh() {
    setRows((await fetchCaptures()).captures);
  }
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await fetchCaptures(controller.signal);
        if (!controller.signal.aborted) setRows(data.captures);
      } catch (failure) {
        if (!isCanceled(failure)) setError(errorMessage(failure));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    void fetchImportModel()
      .then((data) => {
        if (!controller.signal.aborted) setModel(data.model);
        return undefined;
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const row = rows.find((r) => r.id === id) ?? rows[0];
  return (
    <section aria-label="网页采集管理" className="space-y-4 rounded-xl border p-4">
      <h2 className="text-lg font-semibold">网页采集与来源更新</h2>
      <Field>
        <FieldLabel htmlFor="import-urls">网页链接（每行一个，每批最多 20 个）</FieldLabel>
        <Textarea
          id="import-urls"
          rows={3}
          value={urls}
          disabled={busy}
          onChange={(e) => {
            setUrls(e.target.value);
            setBatchId(crypto.randomUUID());
          }}
        />
      </Field>
      <div className="flex gap-2">
        <Button
          disabled={busy || !urls.trim()}
          onClick={() =>
            void run(async () => {
              const data = await startCapture(
                batchId,
                urls
                  .split(/\n+/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              );
              setId(data.captures[0]?.id ?? null);
              setUrls('');
              setBatchId(crypto.randomUUID());
            })
          }
        >
          采集网页正文
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await onKnowledgeChanged();
            })
          }
        >
          刷新任务与知识状态
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="grid items-start gap-5 xl:grid-cols-[16rem_1fr]">
        <nav aria-label="采集任务" className="max-h-[40rem] space-y-2 overflow-y-auto">
          <p className="text-xs text-muted-foreground">最近 100 份采集记录</p>
          {rows.map((r) => (
            <Button
              key={r.id}
              variant={r.id === row?.id ? 'secondary' : 'outline'}
              className="h-auto w-full justify-start py-3 text-left whitespace-normal"
              onClick={() => setId(r.id)}
            >
              <span className="min-w-0 space-y-1">
                <span className="block break-all">{r.snapshot?.title ?? r.url}</span>
                <span className="block text-xs">
                  {STATUS[r.status]}
                  {r.organization ? ` · ${ORGANIZATION[r.organization.status]}` : ''}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString()} · 批次 {r.batchId.slice(0, 8)}
                </span>
              </span>
            </Button>
          ))}
          {!rows.length ? <p className="text-sm text-muted-foreground">尚无采集任务。</p> : null}
        </nav>
        {row ? (
          <CaptureDetail
            key={row.id}
            row={row}
            boards={boards}
            items={items}
            model={model}
            busy={busy}
            run={run}
            onKnowledgeChanged={onKnowledgeChanged}
            onRecapture={(url) =>
              run(async () => {
                const data = await startCapture(crypto.randomUUID(), [url]);
                setId(data.captures[0]?.id ?? null);
              })
            }
          />
        ) : null}
      </div>
    </section>
  );
}
