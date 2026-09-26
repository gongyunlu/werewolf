import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { LiveAction } from '@/lib/preview';
import { LiveActionRow, ActionRow } from './ActionRow';
import { fetchActionDetail } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({ fetchActionDetail: vi.fn() }));

it('展开当次查询和已发送经验，展示保存正文，不读取当前经验池', async () => {
  const experience = {
    id: 'e1',
    version: 1,
    agentId: 'source-agent',
    agentName: '甲',
    generationId: 'g1',
    sourceGameId: 'old',
    sourcePlayerId: 'p1',
    boardId: '6p_white_wolf',
    role: 'guard',
    title: '历史经验',
    body: '当时保存的正文',
    conditions: '公开信息不足时',
    sourceIds: ['s1'],
  };
  vi.mocked(fetchActionDetail).mockResolvedValue({
    reasoning: null,
    steps: [],
    experienceRetrieval: {
      status: 'completed',
      model: '向量模型',
      query: '当前玩家可见的情境',
      failure: null,
      candidates: [{ id: 'e1', similarity: 0.8 }],
      selected: [experience],
    },
    experienceInputs: [
      { callId: 'c1', step: 'generate', dispatched: true, experiences: [experience] },
    ],
  });
  render(
    <MemoryRouter>
      <ActionRow
        gameId="next"
        stopped
        action={{
          actionKey: 'a1',
          actionType: 'guard_protect',
          actorId: 'p2',
          ledgerSeq: 1,
          phase: 'night',
          seatNo: 2,
        }}
      />
    </MemoryRouter>,
  );
  expect(fetchActionDetail).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: /已中断/ }));
  await screen.findByText(/已实际发送/);
  await userEvent.click(screen.getByText(/当次检索：已完成/));
  expect(screen.getByText('当前玩家可见的情境')).toBeVisible();
  expect(screen.getByText(/相似度 0.800/)).toBeVisible();
  expect(screen.getAllByText('当时保存的正文')).toHaveLength(2);
  expect(screen.getByText(/输入不代表模型明确采纳/)).toBeVisible();
  expect(fetchActionDetail).toHaveBeenCalledExactlyOnceWith('next', 'a1');
});

describe('发言过程', () => {
  it('流式首稿明确标为未发布，复核时折叠首稿，修订仍属于草稿', async () => {
    const action: LiveAction = {
      actionKey: 'speech-1',
      day: 1,
      seatNo: 1,
      actionType: 'speech',
      steps: [
        { id: 'g1', name: 'generate', status: 'running', content: '首稿内容', reasoning: null },
      ],
    };
    const view = render(<LiveActionRow action={action} stopped={false} />);
    expect(screen.getByText('首稿内容')).toBeInTheDocument();
    expect(screen.getByText('发言草稿（未发布）')).toBeInTheDocument();

    view.rerender(
      <LiveActionRow
        action={{
          ...action,
          steps: [
            { ...action.steps[0], status: 'completed' },
            { id: 'c1', name: 'critique', status: 'running', content: '', reasoning: null },
          ],
        }}
        stopped={false}
      />,
    );
    expect(screen.queryByText('首稿内容')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '发言草稿（过程记录）' }));
    expect(screen.getByText('首稿内容')).toBeInTheDocument();

    view.rerender(
      <LiveActionRow
        action={{
          ...action,
          steps: [
            { id: 'r1', name: 'revise', status: 'running', content: '修订内容', reasoning: null },
          ],
        }}
        stopped={false}
      />,
    );
    expect(screen.getByText('修订稿（未发布）')).toBeInTheDocument();
    expect(screen.getByText('修订内容')).toBeInTheDocument();
  });
});
