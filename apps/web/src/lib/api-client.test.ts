import {
  HealthResponseSchema,
  ReviewPreviewSchema,
  ReviewResponseSchema,
  ReviewStartResponseSchema,
} from '@werewolf/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http } from './http';
import { saveAdminToken } from './admin-token';
import {
  createGame,
  fetchHealth,
  runGame,
  fetchReview,
  fetchReviewPreview,
  startReview,
} from './api-client';

vi.mock('./http', () => ({
  http: { get: vi.fn(), post: vi.fn() },
}));

describe('fetchHealth', () => {
  it('取 /health 并返回响应体', async () => {
    vi.mocked(http.get).mockResolvedValue({ status: 'ok' });

    await expect(fetchHealth()).resolves.toEqual({ status: 'ok' });
    expect(http.get).toHaveBeenCalledWith('/health', { schema: HealthResponseSchema });
  });

  it('请求失败时向上抛出', async () => {
    vi.mocked(http.get).mockRejectedValue(new Error('500'));

    await expect(fetchHealth()).rejects.toThrow('500');
  });
});

describe('复盘接口装配', () => {
  beforeEach(() => {
    vi.mocked(http.get).mockReset().mockResolvedValue({});
    vi.mocked(http.post).mockReset().mockResolvedValue({ status: 'waiting' });
  });

  it('预览和报告仅 GET，使用对应的响应校验并传递取消信号', async () => {
    const signal = new AbortController().signal;
    await fetchReviewPreview('g-review', signal);
    await fetchReview('g-review', signal);
    expect(http.get).toHaveBeenCalledWith('/games/g-review/review/preview', {
      schema: ReviewPreviewSchema,
      signal,
    });
    expect(http.get).toHaveBeenCalledWith('/games/g-review/review', {
      schema: ReviewResponseSchema,
      signal,
    });
  });

  it('生成和续跑使用同一 POST，携带管理令牌', async () => {
    saveAdminToken('review-token');
    await startReview('g-review');
    expect(http.post).toHaveBeenCalledWith('/games/g-review/review', undefined, {
      schema: ReviewStartResponseSchema,
      headers: { 'x-admin-token': 'review-token' },
    });
  });
});

describe('写请求带管理令牌', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('开局带上本机那把令牌', async () => {
    saveAdminToken('sk-admin');
    vi.mocked(http.post).mockResolvedValue({ gameId: 'g-1', status: 'queued' } as never);

    await createGame('6p_white_wolf', ['a1', 'a2']);

    expect(http.post).toHaveBeenCalledWith(
      '/games',
      { boardId: '6p_white_wolf', agentIds: ['a1', 'a2'] },
      expect.objectContaining({ headers: { 'x-admin-token': 'sk-admin' } }),
    );
  });

  it('续跑带上同一把', async () => {
    saveAdminToken('sk-admin');
    vi.mocked(http.post).mockResolvedValue({ gameId: 'g-1', status: 'queued' } as never);

    await runGame('g-1');

    expect(http.post).toHaveBeenCalledWith(
      '/games/g-1/run',
      undefined,
      expect.objectContaining({ headers: { 'x-admin-token': 'sk-admin' } }),
    );
  });
});
