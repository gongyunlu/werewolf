import { KNOWLEDGE_KINDS, type KnowledgeSnapshot } from '@werewolf/shared';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { actionTypeName, roleName } from '@/lib/labels';

export function KnowledgeCard({
  knowledge,
  link = false,
}: {
  knowledge: Pick<KnowledgeSnapshot, 'content'> & Partial<Omit<KnowledgeSnapshot, 'content'>>;
  link?: boolean;
}) {
  const c = knowledge.content;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          {c.title}{' '}
          <Badge variant="secondary">
            {KNOWLEDGE_KINDS[c.kind]}
            {knowledge.version ? ` · v${knowledge.version}` : ' · 待确认'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm wrap-anywhere">
        <p className="whitespace-pre-wrap">{c.body}</p>
        <p>适用条件：{c.conditions}</p>
        <p>本局适配：{c.adaptation}</p>
        <p className="text-xs text-muted-foreground">规则基线：{c.rulesBasis}</p>
        <p className="text-xs text-muted-foreground">
          板子：{c.boardIds.join('、') || '未限定（仅查阅）'} · 角色：
          {c.roles.map(roleName).join('、') || '仅查阅'} · 行动：
          {c.actionTypes.map(actionTypeName).join('、') || '不参与检索'}
          {c.firstDayOnly ? ' · 仅第1天' : ''}
          {c.minDay > 1 ? ` · 第${c.minDay}天起` : ''}
        </p>
        <ul className="flex flex-col gap-2 text-xs text-muted-foreground">
          {c.sources.map((source, i) => (
            <li key={i}>
              <a href={source.url} target="_blank" rel="noreferrer" className="underline">
                {source.title}
              </a>
              {source.captureId ? (
                <Link
                  className="ml-2 underline"
                  to={`/knowledge/sources/${source.captureId}#${source.paragraphIds?.[0] ?? ''}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  采集时正文
                </Link>
              ) : null}
              <span>
                {' '}
                · {source.publisher}
                {source.author ? ` / ${source.author}` : ''} · {source.locator}
              </span>
              <p>
                发布：{source.publishedOn ?? '未知'} · 人工核对：{source.checkedOn}
              </p>
            </li>
          ))}
        </ul>
        {link && knowledge.id && knowledge.versionId ? (
          <Link
            to={`/knowledge?id=${knowledge.id}&version=${knowledge.versionId}`}
            className="text-xs underline"
          >
            查看知识及版本
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
