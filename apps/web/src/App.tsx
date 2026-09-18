import { Outlet } from 'react-router-dom';

export function App() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <Outlet />
    </div>
  );
}
