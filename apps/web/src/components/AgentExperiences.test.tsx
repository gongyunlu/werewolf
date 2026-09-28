import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { AgentExperiences } from './AgentExperiences';
import {
  fetchExperiences,
  toggleExperience,
  fetchExperienceSources,
  editExperience,
  archiveExperience,
  indexExperience,
} from '@/lib/experience-api';

vi.mock('@/lib/experience-api', () => ({
  fetchExperiences: vi.fn(),
  toggleExperience: vi.fn(),
  fetchExperienceSources: vi.fn(),
  editExperience: vi.fn(),
  archiveExperience: vi.fn(),
  indexExperience: vi.fn(),
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
  expect(toggleExperience).toHaveBeenNthCalledWith(1, agent.id, item.id, false, undefined);
  expect(toggleExperience).toHaveBeenNthCalledWith(2, agent.id, item.id, true, undefined);
  expect(fetchExperienceSources).not.toHaveBeenCalled();
});
it('编辑保存不调用索引，显示新版本和历史正文；显式索引失败显示原因和调用号', async () => {
  const changed = {
    ...item,
    body: '以当时可见证据核对',
    version: 2,
    revision: 1,
    enabled: false,
    history: [item],
    indexStatus: 'draft' as const,
  };
  vi.mocked(fetchExperiences).mockResolvedValue({ experiences: [item] });
  vi.mocked(editExperience).mockResolvedValue({ experiences: [changed] });
  vi.mocked(indexExperience).mockResolvedValue({
    experiences: [
      {
        ...changed,
        indexStatus: 'failed',
        indexFailure: '索引失败，续跑将复用答复',
        indexCalls: [{ callId: 'index-call-1', status: 'responded' }],
      },
    ],
  });
  render(
    <MemoryRouter>
      <AgentExperiences agent={agent} onClose={() => {}} />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '编辑经验' }));
  await user.clear(screen.getByLabelText('正文'));
  await user.type(screen.getByLabelText('正文'), changed.body);
  await user.click(screen.getByRole('button', { name: '保存新版本' }));
  await screen.findByText(changed.body);
  expect(editExperience).toHaveBeenCalledExactlyOnceWith(agent.id, item.id, 0, {
    title: item.title,
    body: changed.body,
    conditions: item.conditions,
  });
  expect(indexExperience).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '重新启用' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '历史版本' }));
  expect(screen.getByText(item.body)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '建立索引' }));
  expect(indexExperience).toHaveBeenCalledExactlyOnceWith(agent.id, item.id, 2);
  await screen.findByText('索引失败，续跑将复用答复');
  expect(screen.getByText(/index-call-1/)).toBeInTheDocument();
});

it('归档默认隐藏，勾选后可查看来源并恢复为停用，不自动启用', async () => {
  vi.mocked(fetchExperiences).mockResolvedValue({ experiences: [{ ...item, revision: 0 }] });
  vi.mocked(archiveExperience)
    .mockResolvedValueOnce({
      experiences: [{ ...item, archived: true, enabled: false, revision: 1 }],
    })
    .mockResolvedValueOnce({
      experiences: [{ ...item, archived: false, enabled: false, revision: 2 }],
    });
  render(
    <MemoryRouter>
      <AgentExperiences agent={agent} onClose={() => {}} />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '归档经验' }));
  await screen.findByText(/当前没有未归档经验/);
  expect(screen.queryByText(item.body)).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: '显示已归档经验' }));
  expect(screen.getByText('已归档')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '来源证据' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '编辑经验' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '恢复为停用' }));
  await screen.findByText('已停用');
  expect(archiveExperience).toHaveBeenNthCalledWith(1, agent.id, item.id, 0, true);
  expect(archiveExperience).toHaveBeenNthCalledWith(2, agent.id, item.id, 1, false);
  expect(toggleExperience).not.toHaveBeenCalled();
});

it('保存冲突保留草稿；未知索引不可重发', async () => {
  vi.mocked(fetchExperiences).mockResolvedValue({
    experiences: [
      {
        ...item,
        version: 2,
        enabled: false,
        indexStatus: 'unknown',
        indexFailure: '上次请求结果未知',
      },
    ],
  });
  vi.mocked(editExperience).mockRejectedValue(new Error('经验已被修改，请刷新后重试'));
  render(
    <MemoryRouter>
      <AgentExperiences agent={agent} onClose={() => {}} />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await screen.findByText('上次请求结果未知');
  expect(screen.getByRole('button', { name: '继续索引' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '编辑经验' }));
  await user.clear(screen.getByLabelText('标题'));
  await user.type(screen.getByLabelText('标题'), '我的修改');
  await user.click(screen.getByRole('button', { name: '保存新版本' }));
  await screen.findByText('经验已被修改，请刷新后重试');
  expect(screen.getByLabelText('标题')).toHaveValue('我的修改');
  expect(indexExperience).not.toHaveBeenCalled();
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
