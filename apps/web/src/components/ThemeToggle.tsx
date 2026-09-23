import { MoonIcon, SunIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { applyTheme, saveTheme, storedTheme, THEMES, type Theme } from '@/lib/theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(storedTheme);

  const toggle = () => {
    const next = theme === THEMES.DARK ? THEMES.LIGHT : THEMES.DARK;

    applyTheme(next);
    saveTheme(next);
    setTheme(next);
  };

  return (
    <Button variant="ghost" size="icon-sm" aria-label="切换主题" onClick={toggle}>
      {theme === THEMES.DARK ? <MoonIcon /> : <SunIcon />}
    </Button>
  );
}
