import type { KnowledgeContent } from '@werewolf/shared';
import { KNOWLEDGE_KINDS } from '@werewolf/shared';
import { actionTypeName, roleName } from '@/lib/labels';

const values = (c: KnowledgeContent) => ({
  类型: KNOWLEDGE_KINDS[c.kind],
  标题: c.title,
  正文: c.body,
  适用条件: c.conditions,
  本局适配: c.adaptation,
  规则基线: c.rulesBasis,
  板子: c.boardIds.join('、'),
  角色: c.roles.map(roleName).join('、'),
  行动: c.actionTypes.map(actionTypeName).join('、'),
  天数: c.firstDayOnly ? '仅第1天' : `第${c.minDay}天起`,
  来源: c.sources
    .map(
      (s) =>
        `${s.publisher} · ${s.title} · ${s.url} · ${s.locator} · 作者 ${s.author || '未知'} · 发布 ${s.publishedOn || '未知'} · 核对 ${s.checkedOn}${s.captureId ? ` · 快照 ${s.captureId} · ${s.paragraphIds?.join('、')}` : ''}`,
    )
    .join('\n'),
});
export function KnowledgeChanges({
  before,
  after,
}: {
  before: KnowledgeContent;
  after: KnowledgeContent;
}) {
  const old = values(before);
  const changed = Object.entries(values(after)).filter(
    ([key, value]) => old[key as keyof typeof old] !== value,
  );
  return (
    <details open>
      <summary>保存前核对差异（{changed.length} 项）</summary>
      <dl className="mt-3 flex flex-col gap-3 text-sm">
        {changed.map(([key, value]) => (
          <div key={key}>
            <dt className="font-medium">{key}</dt>
            <dd className="whitespace-pre-wrap text-muted-foreground">
              原内容：{old[key as keyof typeof old]}
            </dd>
            <dd className="whitespace-pre-wrap">候选内容：{value}</dd>
          </div>
        ))}
      </dl>
      {!changed.length ? <p>内容没有变化。</p> : null}
    </details>
  );
}
