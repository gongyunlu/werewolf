import { HealthResponseSchema, type HealthResponse } from '@werewolf/shared';
import { http } from './http';

export async function fetchHealth(): Promise<HealthResponse> {
  return http.get('/health', { schema: HealthResponseSchema });
}
