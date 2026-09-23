import {
  AGENT_MEMORY_LIMIT,
  ReplaceAgentMemoriesRequestSchema,
  type AgentMemoryItem,
} from '@werewolf/shared';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { fetchAgentMemories, replaceAgentMemories } from '@/lib/api-client';
import { errorMessage, isCanceled } from '@/lib/http';

const EMPTY: AgentMemoryItem = { title: '', body: '' };

export function PersonaStrategyPanel({ agentId }: { agentId: string }) {
  const [persona, setPersona] = useState<AgentMemoryItem[]>([]);
  const [strategy, setStrategy] = useState<AgentMemoryItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      setStatus('loading');
      setSaved(false);
      try {
        const response = await fetchAgentMemories(agentId);

        if (!alive) {
          return;
        }

        setPersona(response.memories.persona);
        setStrategy(response.memories.strategy);
        setError(null);
        setStatus('ready');
      } catch (failure) {
        if (alive && !isCanceled(failure)) {
          setError(errorMessage(failure));
          setStatus('failed');
        }
      }
    };

    void load();

    return () => {
      alive = false;
    };
  }, [agentId]);

  const total = persona.length + strategy.length;

  const handleSave = async () => {
    setError(null);
    setSaved(false);
    const result = ReplaceAgentMemoriesRequestSchema.safeParse({ persona, strategy });
    if (!result.success) {
      setError(result.error.issues[0].message);
      return;
    }
    setSaving(true);

    try {
      await replaceAgentMemories(agentId, result.data);
      setSaved(true);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {status === 'ready' ? (
        <fieldset disabled={saving} className="flex flex-col gap-4">
          <MemoryList
            label="人设"
            items={persona}
            onChange={(items) => {
              setPersona(items);
              setSaved(false);
            }}
          />
          <MemoryList
            label="策略"
            items={strategy}
            onChange={(items) => {
              setStrategy(items);
              setSaved(false);
            }}
          />
        </fieldset>
      ) : status === 'loading' ? (
        <p>正在读取…</p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button
          disabled={saving || status !== 'ready' || total > AGENT_MEMORY_LIMIT}
          onClick={handleSave}
        >
          保存
        </Button>
        <span className="text-xs text-muted-foreground">
          合计 {total} / {AGENT_MEMORY_LIMIT} 条 · 顺序即内容，按这个顺序拼进提示词
        </span>
        {saved ? <span className="text-xs text-muted-foreground">已保存</span> : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

/** 一类条目：顺序能调，能删能加。 */
function MemoryList({
  label,
  items,
  onChange,
}: {
  label: string;
  items: readonly AgentMemoryItem[];
  onChange: (items: AgentMemoryItem[]) => void;
}) {
  const replace = (index: number, next: AgentMemoryItem) =>
    onChange(items.map((item, at) => (at === index ? next : item)));

  const move = (index: number, delta: number) => {
    const next = [...items];
    const [moved] = next.splice(index, 1);

    if (!moved) {
      return;
    }

    next.splice(index + delta, 0, moved);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button variant="outline" size="sm" onClick={() => onChange([...items, EMPTY])}>
          <PlusIcon data-icon="inline-start" />
          加一条
        </Button>
      </div>

      {items.length === 0 ? <p className="text-sm text-muted-foreground">还没有{label}。</p> : null}

      {items.map((item, index) => (
        // 条目按位置认：标题空着的时候没有别的稳定标识，顺序一变重挂就是对的
        <div key={index} className="flex flex-col gap-2 rounded-lg border p-2">
          <div className="flex items-center gap-2">
            <Input
              aria-label={`${label}标题`}
              placeholder="标题"
              value={item.title}
              onChange={(event) => replace(index, { ...item, title: event.target.value })}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${label}上移`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${label}下移`}
              disabled={index === items.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${label}删除`}
              onClick={() => onChange(items.filter((_, at) => at !== index))}
            >
              <Trash2Icon />
            </Button>
          </div>
          <Textarea
            aria-label={`${label}正文`}
            placeholder="正文"
            value={item.body}
            onChange={(event) => replace(index, { ...item, body: event.target.value })}
          />
        </div>
      ))}
    </div>
  );
}
