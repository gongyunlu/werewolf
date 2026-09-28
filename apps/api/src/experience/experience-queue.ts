export const EXPERIENCE_QUEUE = 'personal-experiences';
export type ExperienceJob =
  | {
      generationId: string;
    }
  | { experienceId: string; version: number };
