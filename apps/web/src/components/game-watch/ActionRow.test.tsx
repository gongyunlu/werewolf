import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { LiveAction } from '@/lib/preview';
import { LiveActionRow, ActionRow } from './ActionRow';
import { fetchActionDetail } from '@/lib/api-client';
import type { ActionDetailResponse } from '@werewolf/shared';

vi.mock('@/lib/api-client', () => ({ fetchActionDetail: vi.fn() }));

beforeEach(() => vi.mocked(fetchActionDetail).mockReset());

it.each([false, true])(
  '未完成详情已返回或仍在途（%s）时，完成行动重新读取最终详情',
  async (inFlight) => {
    let resolvePending!: (detail: ActionDetailResponse) => void;
    const oldDetail = {
      reasoning: null,
      steps: [
        {
          id: 'old',
          name: 'generate',
          status: 'failed' as const,
          content: '旧的中断内容',
          reasoning: null,
        },
      ],
    };
    vi.mocked(fetchActionDetail)
      .mockResolvedValue({
        reasoning: '续跑后的完整理由',
        steps: [],
      })
      .mockImplementationOnce(() =>
        inFlight
          ? new Promise((resolve) => {
              resolvePending = resolve;
            })
          : Promise.resolve(oldDetail),
      );
    const pending = {
      actionKey: 'a1',
      actionType: 'wolf_explode' as const,
      actorId: 'p1',
      ledgerSeq: 1,
      phase: 'day',
      seatNo: 1,
    };
    const view = render(<ActionRow gameId="g1" action={pending} stopped />);
    await userEvent.click(screen.getByRole('button', { name: /已中断/ }));
    if (!inFlight) await screen.findByText('旧的中断内容');
    view.rerender(
      <ActionRow
        gameId="g1"
        action={{
          ...pending,
          day: 1,
          role: '狼人',
          task: '决定是否自爆',
          decision: false,
          eventSeq: null,
          hasReasoning: true,
        }}
      />,
    );
    await screen.findByRole('button', { name: '思考过程' });
    expect(vi.mocked(fetchActionDetail).mock.calls[0][2]?.aborted).toBe(true);
    if (inFlight) await act(async () => resolvePending(oldDetail));
    expect(screen.queryByText('旧的中断内容')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /已完成/ }));
    await userEvent.click(screen.getByRole('button', { name: /已完成/ }));
    expect(fetchActionDetail).toHaveBeenCalledTimes(2);
  },
);

it('读取失败后重试当前行动，清除错误并显示新详情', async () => {
  vi.mocked(fetchActionDetail)
    .mockRejectedValueOnce(new Error('读取失败'))
    .mockResolvedValue({ reasoning: '重新读取的理由', steps: [] });
  render(
    <ActionRow
      gameId="g1"
      action={{
        actionKey: 'a1',
        actionType: 'wolf_explode',
        actorId: 'p1',
        ledgerSeq: 1,
        phase: 'day',
        seatNo: 1,
      }}
      stopped
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: /已中断/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
  await userEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findByRole('button', { name: '思考过程' });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetchActionDetail).toHaveBeenCalledTimes(2);
});

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
  expect(fetchActionDetail).toHaveBeenCalledExactlyOnceWith('next', 'a1', expect.any(AbortSignal));
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
