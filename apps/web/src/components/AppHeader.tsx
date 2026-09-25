import { KeyRoundIcon } from 'lucide-react';
import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { AdminTokenDialog } from '@/components/AdminTokenDialog';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 导航就这几处，多一处都得先有那个页面。 */
const NAV = [
  { to: '/', label: '首页' },
  { to: '/games', label: '对局' },
  { to: '/agents', label: '参赛者' },
];

export function AppHeader() {
  const [tokenOpen, setTokenOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 h-12 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-full w-full max-w-[112rem] items-center gap-4 px-4 sm:px-6">
        <NavLink to="/" className="shrink-0 text-sm font-semibold">
          AI 狼人杀
        </NavLink>

        <nav className="flex items-center gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground',
                  isActive && 'bg-muted text-foreground',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* 令牌是全站的：开局、续跑、改参赛者都要它，所以入口挂在壳上而不是某一页 */}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="管理令牌"
            onClick={() => setTokenOpen(true)}
          >
            <KeyRoundIcon />
          </Button>
          <ThemeToggle />
        </div>
      </div>

      <AdminTokenDialog open={tokenOpen} onOpenChange={setTokenOpen} />
    </header>
  );
}
