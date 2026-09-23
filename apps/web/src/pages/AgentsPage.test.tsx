import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAgents } from '@/lib/api-client';
import { AgentsPage } from './AgentsPage';

vi.mock('@/lib/api-client', () => ({
  fetchAgents: vi.fn(),
  updateAgent: vi.fn(),
}));
vi.mock('@/components/AgentEditDialog', () => ({ AgentEditDialog: () => null }));

describe('参赛者筛选', () => {
  beforeEach(() => {
    vi.mocked(fetchAgents).mockResolvedValue({
      agents: [
        {
          id: 'a1',
          name: '甲',
          tag: 'ds',
          modelName: '模型',
          baseUrl: null,
          apiKeyHint: null,
          isActive: true,
          notes: '备注',
        },
        {
          id: 'a2',
          name: '乙',
          tag: '方舟',
          modelName: '模型',
          baseUrl: null,
          apiKeyHint: null,
          isActive: true,
          notes: null,
        },
        {
          id: 'a3',
          name: '丙',
          tag: 'ds',
          modelName: '模型',
          baseUrl: null,
          apiKeyHint: null,
          isActive: false,
          notes: null,
        },
      ],
    });
  });

  it('默认显示全部启用者，标签与停用开关可以组合筛选', async () => {
    render(<AgentsPage />);
    await screen.findByText('甲');
    expect(screen.getByRole('combobox', { name: '按标签筛选' })).toHaveTextContent('全部标签');
    expect(screen.queryByText('丙')).toBeNull();
    await userEvent.click(screen.getByRole('combobox', { name: '按标签筛选' }));
    await userEvent.click(screen.getByRole('option', { name: 'ds' }));
    expect(screen.queryByText('乙')).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: '显示已停用' }));
    expect(screen.getByText('丙')).toBeInTheDocument();
    expect(screen.getByText('共 2 位参赛者')).toBeInTheDocument();
  });
});
