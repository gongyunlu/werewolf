/** 主题只有深浅两档：默认深色，选过的那一档记在本地。 */
export const THEMES = { DARK: 'dark', LIGHT: 'light' } as const;

export type Theme = (typeof THEMES)[keyof typeof THEMES];

const STORAGE_KEY = 'werewolf:theme';

/** 取上一次选的；没选过、或者存的值不认得，都按默认的深色。 */
export function storedTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);

  return saved === THEMES.LIGHT ? THEMES.LIGHT : THEMES.DARK;
}

/** 挂在 html 上：shadcn 的语义变量按这个类切换。 */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === THEMES.DARK);
}

export function saveTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
}
