import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchReview, fetchReviewPreview, fetchReviewProgress } from '@/lib/api-client';
import { reviewPreview, reviewResponse } from '@/test/review-fixture';
import { useGameReview } from './useGameReview';

vi.mock('@/lib/api-client', () => ({
  fetchReview: vi.fn(),
  fetchReviewPreview: vi.fn(),
  fetchReviewProgress: vi.fn(),
  startReview: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.mocked(fetchReviewPreview).mockResolvedValue(reviewPreview);
  vi.mocked(fetchReview).mockResolvedValue(reviewResponse('active'));
  vi.mocked(fetchReviewProgress).mockResolvedValue({
    status: 'active',
    revision: '1',
    failure: null,
  });
});

afterEach(() => vi.useRealTimers());

it('五秒轮询只读进度，进度未变不重取报告，手动刷新仍重取', async () => {
  const view = renderHook(() => useGameReview('g-review'));
  await act(() => vi.advanceTimersByTimeAsync(15000));
  expect(fetchReviewProgress).toHaveBeenCalledTimes(4);
  expect(fetchReview).toHaveBeenCalledTimes(1);

  vi.mocked(fetchReviewProgress).mockResolvedValue({
    status: 'active',
    revision: '2',
    failure: null,
  });
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(fetchReview).toHaveBeenCalledTimes(2);
  await act(async () => view.result.current.refresh());
  expect(fetchReview).toHaveBeenCalledTimes(3);
  view.unmount();
});

it('读取进度后任务被续跑，以完整报告状态继续轮询直到完成', async () => {
  vi.mocked(fetchReviewProgress).mockResolvedValueOnce({
    status: 'failed',
    revision: '1',
    failure: '复盘任务失败',
  });
  const view = renderHook(() => useGameReview('g-review'));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(view.result.current.data?.status).toBe('active');

  vi.mocked(fetchReview).mockResolvedValue(reviewResponse());
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(fetchReviewProgress).toHaveBeenCalledTimes(2);
  expect(fetchReview).toHaveBeenCalledTimes(2);
  expect(view.result.current.data?.status).toBe('completed');
  await act(() => vi.advanceTimersByTimeAsync(20000));
  expect(fetchReviewProgress).toHaveBeenCalledTimes(2);
  view.unmount();
});

it('报告更新失败保留已读内容并重试同一进度，完成后停止轮询', async () => {
  const view = renderHook(() => useGameReview('g-review'));
  await act(() => vi.advanceTimersByTimeAsync(0));
  const original = view.result.current.data;
  vi.mocked(fetchReviewProgress).mockResolvedValue({
    status: 'completed',
    revision: '2',
    failure: null,
  });
  vi.mocked(fetchReview)
    .mockRejectedValueOnce(new Error('报告暂不可读'))
    .mockResolvedValue(reviewResponse());
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(view.result.current.data).toBe(original);
  expect(view.result.current.readError).toBe('报告暂不可读');
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(view.result.current.data?.status).toBe('completed');
  expect(view.result.current.readError).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(20000));
  expect(fetchReviewProgress).toHaveBeenCalledTimes(3);
  expect(fetchReview).toHaveBeenCalledTimes(3);
  view.unmount();
});

it('轻量进度读取失败不重取平台报告，恢复后继续使用已有版本', async () => {
  const view = renderHook(() => useGameReview('g-review'));
  await act(() => vi.advanceTimersByTimeAsync(0));
  vi.mocked(fetchReviewProgress).mockRejectedValueOnce(new Error('暂时离线'));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(view.result.current.readError).toBe('暂时离线');
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(view.result.current.readError).toBeNull();
  expect(fetchReview).toHaveBeenCalledTimes(1);
  view.unmount();
});
