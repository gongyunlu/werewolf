import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchReview, fetchReviewPreview, startReview } from '@/lib/api-client';
import { reviewGame, reviewPreview, reviewResponse } from '@/test/review-fixture';
import { GameReview } from './GameReview';

vi.mock('@/lib/api-client', () => ({
  fetchReview: vi.fn(),
  fetchReviewPreview: vi.fn(),
  startReview: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchReviewPreview).mockResolvedValue(reviewPreview);
  vi.mocked(fetchReview).mockResolvedValue(reviewResponse());
  Element.prototype.scrollIntoView = vi.fn();
});

describe('赛后复盘阅读', () => {
  it('展示历史报告与覆盖缺口，玩家引用可继续定位到原始理由，全局引用定位事件', async () => {
    render(<GameReview game={reviewGame} />);
    expect(await screen.findByText('已完成 3 / 3 项分析')).toBeInTheDocument();
    expect(screen.getByText(/2 位玩家 · 1 条可分析决策 · 1 份玩家汇总/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '查看 1 条证据缺口' }));
    expect(screen.getByText('2 号：行动没有最终结果，不据此判断表现')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '查看证据 D1' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('对应决策分析')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '查看证据 E2' }));
    expect(within(dialog).getByText('这是当时记录的原始理由。')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '返回上一条引用' }));
    expect(within(dialog).getByText('对应决策分析')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    await userEvent.click(screen.getByRole('tab', { name: '全局分析' }));
    expect(screen.getByText('赛后全知视角')).toBeInTheDocument();
    expect(screen.queryByText('玩家当时视角')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '查看证据 O1' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('事件 #9');
    expect(screen.getByRole('dialog')).toHaveTextContent('法官宣布好人胜利');
    expect(startReview).not.toHaveBeenCalled();
  });

  it('逐步分析按需展开，切换玩家后单独显示证据不足', async () => {
    render(<GameReview game={reviewGame} />);
    const decision = await screen.findByRole('button', { name: /1. 第 1 天 · 投票/ });
    await userEvent.click(decision);
    expect(screen.getByText(/决策分析只使用当时的理由/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: '选择复盘玩家' }));
    await userEvent.click(await screen.findByRole('option', { name: '2 号 · 平民' }));
    expect(screen.getByText('没有可分析的最终决定，证据不足')).toBeInTheDocument();
    expect(screen.queryByText(/决策分析只使用当时的理由/)).toBeNull();
  });

  it('刷新和重新打开只读取历史报告，已完成状态没有生成或续跑按钮', async () => {
    const view = render(<GameReview game={reviewGame} />);
    await screen.findByText('已完成 3 / 3 项分析');
    await userEvent.click(screen.getByRole('button', { name: '刷新状态' }));
    await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(2));
    view.unmount();
    render(<GameReview game={reviewGame} />);
    await screen.findByText('已完成 3 / 3 项分析');
    expect(screen.queryByRole('button', { name: /生成复盘|续跑复盘/ })).toBeNull();
    expect(startReview).not.toHaveBeenCalled();
  });
});

describe('手动生成与恢复', () => {
  it('未生成时先展示范围，快速重复点击只提交一次', async () => {
    vi.mocked(fetchReview).mockResolvedValue(reviewResponse('not_started'));
    let release!: (value: { status: string }) => void;
    vi.mocked(startReview).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(<GameReview game={reviewGame} />);
    const start = await screen.findByRole('button', { name: '生成复盘' });
    expect(start).toBeEnabled();
    expect(startReview).not.toHaveBeenCalled();
    fireEvent.click(start);
    fireEvent.click(start);
    expect(startReview).toHaveBeenCalledTimes(1);
    expect(start).toBeDisabled();
    vi.mocked(fetchReview).mockResolvedValue(reviewResponse('waiting'));
    await act(async () => release({ status: 'waiting' }));
    expect(await screen.findByText('排队中')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成复盘' })).toBeNull();
  });

  it.each(['failed', 'interrupted'])('%s 后展示已有分析，续跑原任务并恢复状态', async (status) => {
    vi.mocked(fetchReview).mockResolvedValue(reviewResponse(status));
    vi.mocked(startReview).mockResolvedValue({ status: 'active' });
    render(<GameReview game={reviewGame} />);
    const resume = await screen.findByRole('button', { name: '续跑复盘' });
    expect(screen.getByText('已完成 1 / 3 项分析')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /1. 第 1 天 · 投票/ }));
    expect(screen.getByText(/决策分析只使用当时的理由/)).toBeInTheDocument();
    vi.mocked(fetchReview).mockResolvedValue(reviewResponse('active'));
    await userEvent.click(resume);
    expect(await screen.findByText('生成中')).toBeInTheDocument();
    expect(startReview).toHaveBeenCalledWith('g-review');
    expect(startReview).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/决策分析只使用当时的理由/)).toBeInTheDocument();
  });

  it('排队时刷新后恢复轮询，完成后停止；请求未结束时不叠加查询', async () => {
    vi.useFakeTimers();
    let release!: (value: ReturnType<typeof reviewResponse>) => void;
    vi.mocked(fetchReview).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const view = render(<GameReview game={reviewGame} />);
    try {
      await act(() => vi.advanceTimersByTimeAsync(20000));
      expect(fetchReview).toHaveBeenCalledTimes(1);
      await act(async () => release(reviewResponse('waiting')));
      expect(screen.getByText('排队中')).toBeInTheDocument();
      vi.mocked(fetchReview)
        .mockResolvedValueOnce(reviewResponse('active'))
        .mockResolvedValue(reviewResponse());
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(screen.getByText('生成中')).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(screen.getByText('已完成 3 / 3 项分析')).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(20000));
      expect(fetchReview).toHaveBeenCalledTimes(3);
      expect(startReview).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('提交失败明确显示错误，再读取服务端状态，不自动重发', async () => {
    vi.mocked(fetchReview).mockResolvedValue(reviewResponse('not_started'));
    vi.mocked(startReview).mockRejectedValue(new Error('管理令牌不正确'));
    render(<GameReview game={reviewGame} />);
    await userEvent.click(await screen.findByRole('button', { name: '生成复盘' }));
    expect(await screen.findByText('提交失败：管理令牌不正确')).toBeInTheDocument();
    expect(startReview).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(2));
  });

  it('只读查询失败时保留已有报告，不把网络故障误当成任务失败', async () => {
    render(<GameReview game={reviewGame} />);
    await screen.findByText('已完成 3 / 3 项分析');
    vi.mocked(fetchReview).mockRejectedValue(new Error('平台暂不可用'));
    await userEvent.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('复盘读取失败');
    expect(screen.getByRole('region', { name: '玩家汇总' })).toHaveTextContent('玩家汇总');
    expect(screen.queryByRole('button', { name: /生成复盘|续跑复盘/ })).toBeNull();
    expect(startReview).not.toHaveBeenCalled();
  });

  it('覆盖范围读取失败禁止启动，手动刷新后可以恢复', async () => {
    vi.mocked(fetchReview).mockResolvedValue(reviewResponse('not_started'));
    vi.mocked(fetchReviewPreview).mockRejectedValueOnce(new Error('读取证据失败'));
    render(<GameReview game={reviewGame} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('覆盖范围读取失败');
    expect(screen.getByRole('button', { name: '生成复盘' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '刷新状态' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '生成复盘' })).toBeEnabled());
    expect(startReview).not.toHaveBeenCalled();
  });
});
