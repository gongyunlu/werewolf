import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { HomePage } from './HomePage';

describe('首页', () => {
  it('提供观战与参赛者管理入口', () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'AI 狼人杀' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '开始观战' })).toHaveAttribute('href', '/games');
    expect(screen.getByRole('link', { name: '管理参赛者' })).toHaveAttribute('href', '/agents');
  });
});
