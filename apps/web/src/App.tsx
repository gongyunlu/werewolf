import { Outlet } from 'react-router-dom';
import { AppHeader } from '@/components/AppHeader';

export function App() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <AppHeader />
      <Outlet />
    </div>
  );
}
