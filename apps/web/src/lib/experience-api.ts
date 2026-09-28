import {
  ExperienceGenerationResponseSchema,
  ExperienceListSchema,
  ReviewStartResponseSchema,
  type ExperienceEditable,
} from '@werewolf/shared';
import { adminHeaders } from './admin-token';
import { http } from './http';

export function fetchExperiences(agentId: string, signal?: AbortSignal) {
  return http.get(`/agents/${agentId}/experiences`, { schema: ExperienceListSchema, signal });
}
export function toggleExperience(agentId: string, id: string, enabled: boolean, revision?: number) {
  return http.patch(
    `/agents/${agentId}/experiences/${id}`,
    { enabled, revision },
    { schema: ExperienceListSchema, headers: adminHeaders() },
  );
}
export function editExperience(
  agentId: string,
  id: string,
  revision: number,
  content: ExperienceEditable,
) {
  return http.put(
    `/agents/${agentId}/experiences/${id}/content`,
    { revision, content },
    {
      schema: ExperienceListSchema,
      headers: adminHeaders(),
    },
  );
}
export function archiveExperience(
  agentId: string,
  id: string,
  revision: number,
  archived: boolean,
) {
  return http.patch(
    `/agents/${agentId}/experiences/${id}/archive`,
    { revision, archived },
    {
      schema: ExperienceListSchema,
      headers: adminHeaders(),
    },
  );
}
export function indexExperience(agentId: string, id: string, version: number) {
  return http.post(
    `/agents/${agentId}/experiences/${id}/index`,
    { version },
    {
      schema: ExperienceListSchema,
      headers: adminHeaders(),
    },
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
