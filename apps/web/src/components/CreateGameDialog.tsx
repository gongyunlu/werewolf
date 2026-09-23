import type { AgentSummary, BoardSummary } from '@werewolf/shared';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createGame, fetchAgents } from '@/lib/api-client';
import { errorMessage, isCanceled } from '@/lib/http';

/** 标签筛选里那一项「全部」。 */
const ANY_TAG = '';

export interface CreateGameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  boards: readonly BoardSummary[];
  onCreated: (gameId: string) => void;
}

export function CreateGameDialog({ open, onOpenChange, boards, onCreated }: CreateGameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(35rem,calc(100dvh-2rem))] min-w-0 max-w-2xl flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>开一局</DialogTitle>
          <DialogDescription>
            选择参赛者，开局时随机分配座次和角色。只列启用的参赛者。
          </DialogDescription>
        </DialogHeader>

        {/* 每次打开都重新挂一份：上一回勾的那几个人不该留着 */}
        {open ? (
          <NewGameForm
            boards={boards}
            onCreated={onCreated}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NewGameForm({
  boards,
  onCreated,
  onClose,
}: {
  boards: readonly BoardSummary[];
  onCreated: (gameId: string) => void;
  onClose: () => void;
}) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [boardId, setBoardId] = useState<string | null>(boards[0]?.id ?? null);
  const [tag, setTag] = useState(ANY_TAG);
  const [picked, setPicked] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      try {
        const response = await fetchAgents(false);

        if (alive) {
          setAgents(response.agents);
        }
      } catch (failure) {
        if (alive && !isCanceled(failure)) {
          setError(errorMessage(failure));
        }
      }
    };

    void load();

    return () => {
      alive = false;
    };
  }, []);

  const board = boards.find((item) => item.id === boardId);
  const seats = board?.playerCount ?? 0;
  const enough = seats > 0 && picked.length === seats;
  const tags = [...new Set(agents.map((agent) => agent.tag).filter((value) => value !== null))];
  const visible = tag === ANY_TAG ? agents : agents.filter((agent) => agent.tag === tag);

  const toggle = (agentId: string) => {
    setPicked((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId],
    );
  };

  const submit = async () => {
    if (!boardId) {
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const { gameId } = await createGame(boardId, picked);

      onCreated(gameId);
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
      setCreating(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Label htmlFor="game-board">板子</Label>
          <Select value={boardId} onValueChange={(value: string | null) => setBoardId(value)}>
            <SelectTrigger id="game-board" className="w-full">
              <SelectValue>
                {(value: string | null) => {
                  const found = boards.find((item) => item.id === value);

                  return found ? `${found.name}（${found.playerCount} 人）` : '';
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {boards.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}（{item.playerCount} 人）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-48">
          <Label htmlFor="game-tag">标签</Label>
          <Select value={tag} onValueChange={(value: string | null) => setTag(value ?? ANY_TAG)}>
            <SelectTrigger id="game-tag" className="w-full">
              <SelectValue>
                {(value: string | null) => (value === ANY_TAG ? '全部' : (value ?? '全部'))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_TAG}>全部</SelectItem>
              {tags.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto rounded-lg border p-2">
        {visible.length === 0 ? (
          <p className="p-1 text-sm text-muted-foreground">没有可用的参赛者。</p>
        ) : null}

        {visible.map((agent) => (
          <div key={agent.id} className="flex shrink-0 items-center gap-3 rounded-md px-1 py-1">
            <Checkbox
              id={`pick-${agent.id}`}
              checked={picked.includes(agent.id)}
              onCheckedChange={() => toggle(agent.id)}
            />
            <Label
              htmlFor={`pick-${agent.id}`}
              className="min-w-0 flex-1 justify-between font-normal"
            >
              <span className="shrink-0">{agent.name}</span>
              <span
                className="truncate font-mono text-xs text-muted-foreground"
                title={agent.modelName}
              >
                {agent.modelName}
              </span>
            </Label>
          </div>
        ))}
      </div>

      <p className={enough ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>
        需要 {seats} 个，已选 {picked.length} 个
      </p>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button disabled={!enough || creating} onClick={() => void submit()}>
          开局
        </Button>
      </DialogFooter>
    </div>
  );
}
