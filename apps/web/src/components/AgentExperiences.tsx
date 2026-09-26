import type { AgentExperience, AgentSummary } from '@werewolf/shared';
import { useEffect, useState } from 'react';
import { ExperienceCard } from './ExperienceCard';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { fetchExperiences, toggleExperience } from '@/lib/experience-api';
import { errorMessage } from '@/lib/http';

export function AgentExperiences({ agent, onClose }: { agent: AgentSummary; onClose: () => void }) {
  const [items, setItems] = useState<AgentExperience[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetchExperiences(agent.id, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setItems(data.experiences);
          setError(null);
        }
        return undefined;
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => controller.abort();
    // 手动刷新需要重新读取启停状态。
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [agent.id, revision]);
  const toggle = async (item: AgentExperience) => {
    setBusy(true);
    try {
      setItems((await toggleExperience(agent.id, item.id, !item.enabled)).experiences);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{agent.name} · 个人历史经验</DialogTitle>
          <DialogDescription>
            由已完成复盘及原始证据提炼，与人工人设、策略分开保存。启用后其他参赛者也可检索参考；启停影响后续尚未开始的行动，已保存的行动输入保持不变。
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        {items === null ? (
          <p>正在读取经验…</p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground">还没有个人经验。可从已完成的玩家复盘手动生成。</p>
        ) : (
          items.map((item) => (
            <ExperienceCard key={item.id} experience={item}>
              <Badge variant={item.enabled ? 'secondary' : 'outline'}>
                {item.enabled ? '已启用' : '已停用'}
              </Badge>
              <Badge variant="outline">{item.indexed ? '可向量检索' : '待建立向量索引'}</Badge>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggle(item)}>
                {item.enabled ? '停用经验' : '重新启用'}
              </Button>
            </ExperienceCard>
          ))
        )}
        <Button variant="outline" disabled={busy} onClick={() => setRevision((value) => value + 1)}>
          刷新经验
        </Button>
      </DialogContent>
    </Dialog>
  );
}
