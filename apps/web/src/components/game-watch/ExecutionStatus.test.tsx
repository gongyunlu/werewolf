import type { GameExecution } from '@werewolf/shared';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionStatus } from './ExecutionStatus';

const checkedAt = '2026-09-29T13:39:40.000Z';
const execution: GameExecution = {
  checkedAt,
  workerActive: true,
  phase: 'dayEnd',
  completed: 4,
  total: 5,
  requestTimeoutMs: 600000,
  maxAttempts: 3,
  pending: [
    {
      actionKey: 'k4',
      actorId: 'p4',
      actionType: 'day_end_judgment',
      step: 'generate',
      callStatus: 'started',
      failureCode: null,
      attempt: {
        number: 1,
        status: 'started',
        startedAt: '2026-09-29T13:31:05.000Z',
        finishedAt: null,
        failureCode: null,
      },
    },
  ],
};
const props = {
  execution,
  status: 'running' as const,
  day: 3,
  receivedAt: Date.parse(checkedAt),
  unavailable: false,
  showPlayers: true,
  players: [{ id: 'p4', seatNo: 4 }],
  roster: [{ seatNo: 4, name: '徐瑶' }],
};

afterEach(() => vi.useRealTimers());

describe('执行状态栏', () => {
  it('没有实时文本时也展示日终进度，并按服务端时间计算等待时长', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(checkedAt) + 3600000);
    render(<ExecutionStatus {...props} receivedAt={Date.now()} />);
    expect(screen.getByText('日终整理 · 已完成 4 / 5')).toBeInTheDocument();
    expect(screen.getByText(/4 号 徐瑶/)).toBeInTheDocument();
    expect(screen.getByText(/本次已等待 8 分 35 秒/)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText(/本次已等待 8 分 36 秒/)).toBeInTheDocument();
    expect(screen.getByText(/最近同步：1 秒前/)).toBeInTheDocument();
  });

  it('新尝试重新计时，连接异常或存档过期时停止显示执行动画', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(checkedAt);
    const retry = {
      ...execution,
      pending: [
        {
          ...execution.pending[0],
          attempt: {
            ...execution.pending[0].attempt!,
            number: 2,
            startedAt: checkedAt,
          },
        },
      ],
    };
    const view = render(<ExecutionStatus {...props} execution={retry} />);
    expect(screen.getByText(/重试中 · 第 2 \/ 3 次尝试/)).toBeInTheDocument();
    expect(screen.getByText(/本次已等待 0 秒/)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(11000));
    expect(screen.getByText(/无法确认最新执行状态/)).toBeInTheDocument();
    expect(view.container.querySelector('.animate-spin')).toBeNull();
    view.rerender(
      <ExecutionStatus {...props} execution={retry} unavailable receivedAt={Date.now()} />,
    );
    expect(screen.getByText(/无法确认最新执行状态/)).toBeInTheDocument();
  });

  it('锁失效时不把持久化的运行中记录当作仍在执行，闭眼视角不显示玩家任务', () => {
    vi.useFakeTimers();
    vi.setSystemTime(checkedAt);
    const view = render(
      <ExecutionStatus {...props} execution={{ ...execution, workerActive: false }} />,
    );
    expect(screen.getByText(/未确认到活跃的执行任务/)).toBeInTheDocument();
    expect(view.container.querySelector('.animate-spin')).toBeNull();
    view.rerender(<ExecutionStatus {...props} showPlayers={false} />);
    expect(screen.queryByText(/徐瑶/)).not.toBeInTheDocument();
    expect(screen.queryByText(/日终个人判断/)).not.toBeInTheDocument();
  });

  it('失败显示原因并停止等待计时，完成后移除状态栏', () => {
    vi.useFakeTimers();
    vi.setSystemTime(checkedAt);
    const failed = {
      ...execution,
      workerActive: false,
      pending: [
        {
          ...execution.pending[0],
          callStatus: 'failed',
          failureCode: 'budget_exhausted',
          attempt: { ...execution.pending[0].attempt!, status: 'failed', finishedAt: checkedAt },
        },
      ],
    };
    const view = render(<ExecutionStatus {...props} status="failed" execution={failed} />);
    expect(screen.getByText(/模型请求多次失败/)).toBeInTheDocument();
    expect(screen.queryByText(/本次已等待/)).not.toBeInTheDocument();
    expect(view.container.querySelector('.animate-spin')).toBeNull();
    view.rerender(<ExecutionStatus {...props} status="finished" execution={null} />);
    expect(screen.queryByLabelText('执行状态')).not.toBeInTheDocument();
  });
});
