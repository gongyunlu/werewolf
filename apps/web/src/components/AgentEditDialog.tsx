import type { AgentSummary, UpdateAgentRequest } from '@werewolf/shared';
import { useState } from 'react';
import { PersonaStrategyPanel } from '@/components/PersonaStrategyPanel';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { createAgent, updateAgent } from '@/lib/api-client';
import { errorMessage } from '@/lib/http';

export interface AgentEditDialogProps {
  /** 给 null 就是新建。 */
  agent: AgentSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 存下去了：让列表重取一遍。 */
  onSaved: () => void;
}

export function AgentEditDialog({ agent, open, onOpenChange, onSaved }: AgentEditDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{agent === null ? '新建参赛者' : `编辑：${agent.name}`}</DialogTitle>
          <DialogDescription>
            {agent === null
              ? '建好之后才能填人设与策略。'
              : '端点与密钥要么都有、要么都没有，缺一半后端会拒。'}
          </DialogDescription>
        </DialogHeader>

        {/* 每次打开都重新挂一份：上一次填了一半的那些不该留在框里 */}
        {open ? (
          <AgentForm
            agent={agent}
            onSaved={onSaved}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const emptyToNull = (value: string) => (value === '' ? null : value);

function AgentForm({
  agent,
  onSaved,
  onClose,
}: {
  agent: AgentSummary | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const [modelName, setModelName] = useState(agent?.modelName ?? '');
  const [baseUrl, setBaseUrl] = useState(agent?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [tag, setTag] = useState(agent?.tag ?? '');
  const [notes, setNotes] = useState(agent?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);

    try {
      if (agent === null) {
        await createAgent({
          name,
          modelName,
          baseUrl: emptyToNull(baseUrl),
          apiKey: emptyToNull(apiKey),
          tag: emptyToNull(tag),
          notes: emptyToNull(notes),
        });
      } else {
        const patch: UpdateAgentRequest = {
          modelName,
          baseUrl: emptyToNull(baseUrl),
          tag: emptyToNull(tag),
          notes: emptyToNull(notes),
        };

        // 密钥三态：留空不动、勾了清掉、填了换掉
        if (clearKey) {
          patch.apiKey = null;
        } else if (apiKey !== '') {
          patch.apiKey = apiKey;
        }

        await updateAgent(agent.id, patch);
      }

      onSaved();
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  const form = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor="agent-name">名称</Label>
        <Input
          id="agent-name"
          value={name}
          disabled={agent !== null}
          onChange={(event) => setName(event.target.value)}
        />
        {agent === null ? null : (
          <p className="text-xs text-muted-foreground">名字定下来就不改了：对局里按它认人。</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="agent-model">型号</Label>
        <Input
          id="agent-model"
          value={modelName}
          onChange={(event) => setModelName(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="agent-base-url">端点</Label>
        <Input
          id="agent-base-url"
          placeholder="留空即用环境变量里的默认端点"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="agent-api-key">密钥</Label>
        <Input
          id="agent-api-key"
          type="password"
          placeholder={
            agent?.apiKeyHint ? `留空即不改（当前 ****${agent.apiKeyHint}）` : '留空即不自带密钥'
          }
          value={apiKey}
          disabled={clearKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        {agent?.apiKeyHint ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id="agent-clear-key"
              checked={clearKey}
              onCheckedChange={(checked) => setClearKey(checked)}
            />
            <Label htmlFor="agent-clear-key" className="text-xs font-normal text-muted-foreground">
              清掉已存的密钥
            </Label>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="agent-tag">标签</Label>
        <Input
          id="agent-tag"
          placeholder="开局的勾选列表按它筛"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="agent-notes">备注</Label>
        <Textarea
          id="agent-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button disabled={saving || name === '' || modelName === ''} onClick={() => void submit()}>
          保存
        </Button>
      </DialogFooter>
    </div>
  );

  if (agent === null) {
    return form;
  }

  return (
    <Tabs defaultValue="access">
      <TabsList>
        <TabsTrigger value="access">接入配置</TabsTrigger>
        <TabsTrigger value="persona">人设与策略</TabsTrigger>
      </TabsList>
      <TabsContent value="access">{form}</TabsContent>
      <TabsContent value="persona">
        <PersonaStrategyPanel agentId={agent.id} />
      </TabsContent>
    </Tabs>
  );
}
