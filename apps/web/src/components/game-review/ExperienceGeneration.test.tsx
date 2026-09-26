import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ExperienceGeneration } from './ExperienceGeneration';
import { fetchExperienceGeneration, startExperienceGeneration } from '@/lib/experience-api';

vi.mock('@/lib/experience-api', () => ({
  fetchExperienceGeneration: vi.fn(),
  startExperienceGeneration: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());
it('无绑定和未完成复盘不请求生成接口', () => {
  const view = render(<ExperienceGeneration gameId="g" playerId="p1" completed />);
  expect(screen.getByText(/未绑定持久 agent/)).toBeInTheDocument();
  view.rerender(<ExperienceGeneration gameId="g" playerId="p1" agentId="a" completed={false} />);
  expect(screen.getByText(/完成本局复盘后/)).toBeInTheDocument();
  expect(fetchExperienceGeneration).not.toHaveBeenCalled();
  expect(startExperienceGeneration).not.toHaveBeenCalled();
});
it('显示失败原因，显式续跑后显示零条完成结果', async () => {
  vi.mocked(fetchExperienceGeneration)
    .mockResolvedValueOnce({ status: 'failed', reason: '模型请求失败，可续跑', generation: null })
    .mockResolvedValue({
      status: 'completed',
      reason: null,
      generation: {
        id: 'r',
        agentId: 'a',
        sourceGameId: 'g',
        sourcePlayerId: 'p1',
        reviewVersion: 'v1',
        status: 'completed',
        failure: null,
        result: { experiences: [], reason: '没有新的经验' },
        sources: [],
        calls: [],
      },
    });
  vi.mocked(startExperienceGeneration).mockResolvedValue({ status: 'waiting' });
  render(
    <MemoryRouter>
      <ExperienceGeneration gameId="g" playerId="p1" agentId="a" completed />
    </MemoryRouter>,
  );
  await screen.findByText('模型请求失败，可续跑');
  expect(startExperienceGeneration).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '续跑经验生成' }));
  await screen.findByText('已保存 0 条经验。没有新的经验');
  expect(startExperienceGeneration).toHaveBeenCalledExactlyOnceWith('g', 'p1');
});

it('已提炼但未索引时明确提供补建入口', async () => {
  vi.mocked(fetchExperienceGeneration).mockResolvedValue({
    status: 'not_indexed',
    reason: null,
    generation: {
      id: 'r',
      agentId: 'a',
      sourceGameId: 'g',
      sourcePlayerId: 'p1',
      reviewVersion: 'v1',
      status: 'not_indexed',
      failure: null,
      result: { experiences: [], reason: '测试存量状态' },
      sources: [],
      calls: [],
    },
  });
  render(
    <MemoryRouter>
      <ExperienceGeneration gameId="g" playerId="p1" agentId="a" completed />
    </MemoryRouter>,
  );
  await screen.findByText('已提炼，待建立索引');
  expect(startExperienceGeneration).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '建立或续跑经验索引' }));
  expect(startExperienceGeneration).toHaveBeenCalledExactlyOnceWith('g', 'p1');
});
