import { useState } from 'react';
import { Button } from '@/components/ui/button';
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
import { saveAdminToken, storedAdminToken } from '@/lib/admin-token';

export interface AdminTokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AdminTokenDialog({ open, onOpenChange }: AdminTokenDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>管理令牌</DialogTitle>
          <DialogDescription>
            开一局、续跑、改参赛者都要带它。只存在这台机器上；后端没配 ADMIN_TOKEN 时写接口一律拒。
          </DialogDescription>
        </DialogHeader>

        {/* 每次打开都重新挂一份：上一回填了没保存的那半截不该留着 */}
        {open ? (
          <TokenForm
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TokenForm({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState(storedAdminToken);
  const [saved, setSaved] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor="admin-token">令牌</Label>
        <Input
          id="admin-token"
          type="password"
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
            setSaved(false);
          }}
        />
      </div>

      {saved ? (
        <p className="text-xs text-muted-foreground">{token ? '已存在本机。' : '已从本机撤掉。'}</p>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
        <Button
          onClick={() => {
            saveAdminToken(token);
            setSaved(true);
          }}
        >
          保存
        </Button>
      </DialogFooter>
    </div>
  );
}
