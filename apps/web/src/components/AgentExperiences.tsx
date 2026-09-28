import type { AgentExperience, AgentSummary } from '@werewolf/shared';
import { useEffect, useState } from 'react';
import { ExperienceMaintenanceCard } from './ExperienceMaintenanceCard';
import { Checkbox } from './ui/checkbox';
import { Field, FieldLabel } from './ui/field';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { fetchExperiences } from '@/lib/experience-api';
import { errorMessage } from '@/lib/http';

export function AgentExperiences({ agent, onClose }: { agent: AgentSummary; onClose: () => void }) {
  const [items, setItems] = useState<AgentExperience[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
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
  const change = async (work: () => Promise<{ experiences: AgentExperience[] }>) => {
    setBusy(true);
    try {
      setItems((await work()).experiences);
      setError(null);
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const visible = items?.filter((item) => showArchived || !item.archived);
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
            由已完成复盘及原始证据提炼，与人工人设、策略分开保存。启用后其他参赛者也可检索参考；编辑和归档只影响后续新行动，已保存的行动输入保持不变。停用仍可编辑；归档后隐藏并排除检索，恢复后保持停用。
          </DialogDescription>
        </DialogHeader>
        <Field orientation="horizontal">
          <Checkbox
            id="show-archived-experiences"
            checked={showArchived}
            onCheckedChange={setShowArchived}
          />
          <FieldLabel htmlFor="show-archived-experiences">显示已归档经验</FieldLabel>
        </Field>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        {items === null ? (
          <p>正在读取经验…</p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground">还没有个人经验。可从已完成的玩家复盘手动生成。</p>
        ) : visible?.length ? (
          visible.map((item) => (
            <ExperienceMaintenanceCard
              key={`${item.id}/${item.version}`}
              item={item}
              busy={busy}
              change={change}
            />
          ))
        ) : (
          <p className="text-muted-foreground">
            当前没有未归档经验，可勾选「显示已归档经验」查看。
          </p>
        )}
        <Button variant="outline" disabled={busy} onClick={() => setRevision((value) => value + 1)}>
          刷新经验
        </Button>
      </DialogContent>
    </Dialog>
  );
}
