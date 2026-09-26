import {
  ExperienceGenerationResponseSchema,
  ExperienceListSchema,
  ReviewStartResponseSchema,
} from '@werewolf/shared';
import { adminHeaders } from './admin-token';
import { http } from './http';

export function fetchExperiences(agentId: string, signal?: AbortSignal) {
  return http.get(`/agents/${agentId}/experiences`, { schema: ExperienceListSchema, signal });
}
export function toggleExperience(agentId: string, id: string, enabled: boolean) {
  return http.patch(
    `/agents/${agentId}/experiences/${id}`,
    { enabled },
    { schema: ExperienceListSchema, headers: adminHeaders() },
  );
}
export function fetchExperienceGeneration(gameId: string, playerId: string, signal?: AbortSignal) {
  return http.get(`/games/${gameId}/experience/${encodeURIComponent(playerId)}`, {
    schema: ExperienceGenerationResponseSchema,
    signal,
  });
}
export function startExperienceGeneration(gameId: string, playerId: string) {
  return http.post(`/games/${gameId}/experience/${encodeURIComponent(playerId)}`, undefined, {
    schema: ReviewStartResponseSchema,
    headers: adminHeaders(),
  });
}
export function fetchExperienceSources(id: string) {
  return http.get(`/experiences/generations/${id}`, { schema: ExperienceGenerationResponseSchema });
}
