import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHealth } from '@/lib/api-client';
import { HomePage } from './HomePage';

vi.mock('@/lib/api-client', () => ({
  fetchHealth: vi.fn(),
}));

describe('HomePage', () => {
  afterEach(() => {
    vi.mocked(fetchHealth).mockReset();
  });

  it('后端可用时展示健康状态', async () => {
    vi.mocked(fetchHealth).mockResolvedValue({ status: 'ok' });

    render(<HomePage />);

    expect(await screen.findByText('后端状态：ok')).toBeInTheDocument();
  });

  it('后端不可用时展示不可用', async () => {
    vi.mocked(fetchHealth).mockRejectedValue(new Error('503'));

    render(<HomePage />);

    expect(await screen.findByText('后端状态：不可用')).toBeInTheDocument();
  });
});
