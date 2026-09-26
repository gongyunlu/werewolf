import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { AgentExperiences } from './AgentExperiences';
import { fetchExperiences, toggleExperience, fetchExperienceSources } from '@/lib/experience-api';

vi.mock('@/lib/experience-api', () => ({
  fetchExperiences: vi.fn(),
  toggleExperience: vi.fn(),
  fetchExperienceSources: vi.fn(),
}));
const agent = {
  id: 'agent-1',
  name: '甲',
  modelName: '模型',
  baseUrl: null,
  apiKeyHint: null,
  tag: null,
  notes: null,
  isActive: true,
};
const item = {
  id: 'experience-1',
  agentId: agent.id,
  agentName: agent.name,
  generationId: 'generation-1',
  title: '核对时序',
  body: '先核对发生顺序',
  conditions: '有人解释过去行动时',
  sourceIds: ['s1'],
  version: 1,
  sourceGameId: 'old-game',
  sourcePlayerId: 'p1',
  boardId: '6p_white_wolf',
  role: 'villager',
  enabled: true,
  createdAt: '2026-09-26',
};
beforeEach(() => {
  vi.clearAllMocks();
});
it('读取、停用、重新启用与来源展开仅调用管理和读取接口', async () => {
  vi.mocked(fetchExperiences).mockResolvedValue({ experiences: [item] });
  vi.mocked(toggleExperience)
    .mockResolvedValueOnce({ experiences: [{ ...item, enabled: false }] })
    .mockResolvedValueOnce({ experiences: [item] });
  render(
    <MemoryRouter>
      <AgentExperiences agent={agent} onClose={() => {}} />
    </MemoryRouter>,
  );
  await screen.findByText('先核对发生顺序');
  expect(screen.getByText(/来源参赛者：甲/)).toBeInTheDocument();
  expect(screen.getByText(/启用后其他参赛者也可检索参考/)).toBeInTheDocument();
  expect(screen.getByText('待建立向量索引')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '来源对局与复盘' })).toHaveAttribute(
    'href',
    '/games/old-game?view=review',
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '停用经验' }));
  await screen.findByText('已停用');
  await user.click(screen.getByRole('button', { name: '重新启用' }));
  await screen.findByText('已启用');
  expect(toggleExperience).toHaveBeenNthCalledWith(1, agent.id, item.id, false);
  expect(toggleExperience).toHaveBeenNthCalledWith(2, agent.id, item.id, true);
  expect(fetchExperienceSources).not.toHaveBeenCalled();
});
it('空经验正常显示，读取失败允许刷新', async () => {
  vi.mocked(fetchExperiences)
    .mockRejectedValueOnce(new Error('读取失败'))
    .mockResolvedValueOnce({ experiences: [] });
  render(
    <MemoryRouter>
      <AgentExperiences agent={agent} onClose={() => {}} />
    </MemoryRouter>,
  );
  await screen.findByRole('alert');
  await userEvent.click(screen.getByRole('button', { name: '刷新经验' }));
  await waitFor(() => expect(screen.getByText(/还没有个人经验/)).toBeInTheDocument());
});
