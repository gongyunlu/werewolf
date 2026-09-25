import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppHeader } from './AppHeader';

vi.mock('./ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('./AdminTokenDialog', () => ({ AdminTokenDialog: () => null }));

describe('顶部导航', () => {
  it.each(['/games', '/games/g-20260925-205822', '/games/g-20260925-205822?view=review'])(
    '%s 属于对局菜单',
    (path) => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <AppHeader />
        </MemoryRouter>,
      );
      expect(screen.getByRole('link', { name: '对局' })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('link', { name: '首页' })).not.toHaveAttribute('aria-current');
    },
  );
});
