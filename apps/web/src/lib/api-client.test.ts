import { HealthResponseSchema } from '@werewolf/shared';
import { describe, expect, it, vi } from 'vitest';
import { http } from './http';
import { fetchHealth } from './api-client';

vi.mock('./http', () => ({
  http: { get: vi.fn() },
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
