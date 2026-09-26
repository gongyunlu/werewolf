import type { AgentSummary } from '@werewolf/shared';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AgentExperiences } from '@/components/AgentExperiences';
import { AgentEditDialog } from '@/components/AgentEditDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fetchAgents, updateAgent } from '@/lib/api-client';
import { errorMessage, isCanceled } from '@/lib/http';

/** 管理页要把停用的也列出来。 */
async function listAgents(): Promise<AgentSummary[]> {
  return (await fetchAgents(true)).agents;
}

/** 被下一轮顶掉的那次不算出错；其余折成一行字。 */
function failureOf(failure: unknown): string | null {
  return isCanceled(failure) ? null : errorMessage(failure);
}

export function AgentsPage() {
  const [params, setParams] = useSearchParams();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  // undefined 是没开，null 是新建，给一个 agent 就是编辑那一个
  const [dialog, setDialog] = useState<{ agent: AgentSummary | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tag, setTag] = useState('all');
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const tags = [...new Set(agents.flatMap((agent) => (agent.tag ? [agent.tag] : [])))];
  const tagItems = [
    { value: 'all', label: '全部标签' },
    ...tags.map((value) => ({ value: `tag:${value}`, label: value })),
  ];
  const visible = agents.filter(
    (agent) => (showInactive || agent.isActive) && (tag === 'all' || `tag:${agent.tag}` === tag),
  );

  /** 取失败不动手上这份：空列表与「没取到」看着一样，说不清是哪一种。 */
  const load = async () => {
    try {
      setAgents(await listAgents());
      setError(null);
    } catch (failure) {
      setError(failureOf(failure));
    }
  };

  useEffect(() => {
    let alive = true;

    const tick = async () => {
      try {
        const list = await listAgents();

        if (alive) {
          setAgents(list);
          setError(null);
        }
      } catch (failure) {
        if (alive) {
          setError(failureOf(failure));
        }
      } finally {
        if (alive) setLoading(false);
      }
    };

    void tick();

    return () => {
      alive = false;
    };
  }, []);

  const toggleActive = async (agent: AgentSummary) => {
    try {
      await updateAgent(agent.id, { isActive: !agent.isActive });
      await load();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">参赛者</h1>
          <p className="text-sm text-muted-foreground">
            管理模型接入、人工人设与策略，以及独立保存的个人历史经验。
          </p>
        </div>
        <Button onClick={() => setDialog({ agent: null })}>新建参赛者</Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor="agent-tag-filter">按标签筛选</Label>
        <Select
          items={tagItems}
          value={tag}
          onValueChange={(value) => {
            if (value) setTag(value);
          }}
        >
          <SelectTrigger id="agent-tag-filter" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {tagItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Label className="flex items-center gap-2">
          <Checkbox checked={showInactive} onCheckedChange={(value) => setShowInactive(value)} />
          显示已停用
        </Label>
        <span className="text-sm text-muted-foreground">共 {visible.length} 位参赛者</span>
      </div>

      {loading ? (
        <p className="text-center text-sm text-muted-foreground">读取中…</p>
      ) : visible.length === 0 ? (
        <p className="text-center text-sm text-muted-foreground">没有符合条件的参赛者。</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>标签</TableHead>
              <TableHead>型号</TableHead>
              <TableHead>端点</TableHead>
              <TableHead>密钥</TableHead>
              <TableHead>状态</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((agent) => (
              <TableRow key={agent.id}>
                <TableCell>
                  <span>{agent.name}</span>
                  {agent.notes ? (
                    <p
                      className="max-w-48 truncate text-xs text-muted-foreground"
                      title={agent.notes}
                    >
                      {agent.notes}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground">{agent.tag ?? '—'}</TableCell>
                <TableCell className="font-mono text-xs">{agent.modelName}</TableCell>
                <TableCell className="text-muted-foreground">
                  {agent.baseUrl ?? '环境变量默认'}
                </TableCell>
                {/* 密钥本身不回传，给末四位就够认出是哪一把 */}
                <TableCell className="font-mono text-xs">
                  {agent.apiKeyHint ? `****${agent.apiKeyHint}` : '—'}
                </TableCell>
                <TableCell>
                  <Badge variant={agent.isActive ? 'secondary' : 'outline'}>
                    {agent.isActive ? '启用' : '停用'}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setParams({ experience: agent.id })}
                    >
                      经验
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setDialog({ agent })}>
                      编辑
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void toggleActive(agent)}>
                      {agent.isActive ? '停用' : '启用'}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AgentEditDialog
        agent={dialog?.agent ?? null}
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
          }
        }}
        onSaved={() => void load()}
      />
      {agents
        .filter((agent) => agent.id === params.get('experience'))
        .map((agent) => (
          <AgentExperiences key={agent.id} agent={agent} onClose={() => setParams({})} />
        ))}
    </main>
  );
}
