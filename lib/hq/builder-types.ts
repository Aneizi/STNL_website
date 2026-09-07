export const PROJECT_STAGES = [
  { value: 'idea', label: 'Idea' },
  { value: 'mvp', label: 'Prototype / MVP' },
  { value: 'beta', label: 'Beta / devnet testing' },
  { value: 'live', label: 'Live product' },
  { value: 'revenue', label: 'Revenue-generating' },
  { value: 'growth', label: 'Scaling / growth' },
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number]['value'];
export type BuilderUser = { id: string; email: string; name: string };
export type BuilderHackathon = {
  id: number; name: string; startDate: string; endDate: string;
  externalId: number | null; externalSlug: string | null;
  projectsOpen: boolean; projectsAvailableAt: string | null;
  signupUrl: string; hostingEnabled: boolean;
};
export type BuilderTeam = {
  id: string; name: string; hackathonId: number; hackathonName: string;
  projectUrl: string; description: string; stage: ProjectStage;
  verification: 'pending' | 'verified' | 'rejected';
  ownerId: string; leadUsername: string;
  members: { id: string; name: string; username: string; joined: boolean }[];
};
export type BuilderResult<T = Record<string, never>> =
  | { ok: true; data: T }
  | { ok: false; error: string };
