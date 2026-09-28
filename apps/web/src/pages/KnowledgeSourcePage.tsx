import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { WebSnapshot } from '@werewolf/shared';
import { fetchSourceSnapshot } from '@/lib/knowledge-import-api';
import { errorMessage, isCanceled } from '@/lib/http';

export function KnowledgeSourcePage() {
  const { id } = useParams();
  const [source, setSource] = useState<WebSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetchSourceSnapshot(id!, controller.signal)
      .then(setSource)
      .catch((e) => {
        if (!isCanceled(e)) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [id]);
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <Link to="/knowledge" className="underline">
        返回知识库
      </Link>
      <h1 className="text-2xl font-semibold">采集时的来源正文</h1>
      {error ? (
        <p role="alert">{error}</p>
      ) : source ? (
        <>
          <h2>{source.title}</h2>
          <a href={source.url} target="_blank" rel="noreferrer" className="underline">
            打开原始网页
          </a>
          <p className="text-sm text-muted-foreground">
            来源：{source.publisher} · 采集：{new Date(source.fetchedAt).toLocaleString()} ·
            页面发布时间：{source.publishedOn ?? '未知'}
          </p>
          {source.paragraphs.map((p) => (
            <p id={p.id} key={p.id} className="whitespace-pre-wrap">
              <span className="text-muted-foreground">{p.id} </span>
              {p.text}
            </p>
          ))}
        </>
      ) : (
        <p>正在读取…</p>
      )}
    </main>
  );
}
