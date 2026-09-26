import type { ActionDetailResponse } from '@werewolf/shared';
import { KnowledgeCard } from './KnowledgeCard';

export function KnowledgeInputs({ detail }: { detail: ActionDetailResponse }) {
  return (
    <section aria-label="攻略知识输入" className="mb-4 flex flex-col gap-3">
      <h4 className="text-sm font-medium">本次行动的攻略知识输入</h4>
      <p className="text-xs text-muted-foreground">
        检索命中、选入与实际发送分别记录。输入不代表明确采纳；尚未判断采纳情况。
      </p>
      {detail.knowledgeRetrieval ? (
        <details className="text-xs text-muted-foreground">
          <summary>
            知识检索候选 {detail.knowledgeRetrieval.candidates.length} 条 · 已选{' '}
            {detail.knowledgeRetrieval.selected.length} 条
          </summary>
          <p>与历史经验共用本次查询及向量模型，相似度不代表正确性。</p>
          {detail.knowledgeRetrieval.candidates.map((hit) => (
            <p key={hit.versionId}>
              {hit.id} · 版本 {hit.versionId} · 相似度 {hit.similarity.toFixed(3)}
            </p>
          ))}
          <div className="mt-2 flex flex-col gap-2">
            {detail.knowledgeRetrieval.selected.map((item) => (
              <KnowledgeCard key={item.versionId} knowledge={item} link />
            ))}
          </div>
        </details>
      ) : (
        <p className="text-xs text-muted-foreground">这条历史行动未记录知识检索。</p>
      )}
      {!detail.knowledgeInputs?.length ? (
        <p className="text-xs text-muted-foreground">尚无可追溯的知识调用输入。</p>
      ) : (
        detail.knowledgeInputs.map((call) => (
          <div key={call.callId} className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              {call.step} · {call.dispatched ? '已实际发送' : '已准备，尚未确认发送'} · 调用{' '}
              {call.callId}
            </p>
            {call.knowledge.length ? (
              call.knowledge.map((item) => (
                <KnowledgeCard key={item.versionId} knowledge={item} link />
              ))
            ) : (
              <p className="text-xs text-muted-foreground">此次调用未输入攻略知识。</p>
            )}
          </div>
        ))
      )}
    </section>
  );
}
