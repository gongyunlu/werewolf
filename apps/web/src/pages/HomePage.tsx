import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { fetchHealth } from '@/lib/api-client';

export function HomePage() {
  const [status, setStatus] = useState('检查中');

  const loadStatus = useCallback(
    () =>
      fetchHealth()
        .then((health) => setStatus(health.status))
        .catch(() => setStatus('不可用')),
    [],
  );

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleRefresh = () => {
    setStatus('检查中');
    void loadStatus();
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-6 p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-3xl font-semibold">Werewolf</h1>
        <p className="text-muted-foreground">多智能体狼人杀对局平台</p>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">后端状态：{status}</span>
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          重新检查
        </Button>
      </div>
    </main>
  );
}
