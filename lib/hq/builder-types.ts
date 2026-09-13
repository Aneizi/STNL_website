export const PROJECT_STAGES = [
  { value: 'idea', label: 'Idea' },
  { value: 'mvp', label: 'Prototype / MVP' },
  { value: 'beta', label: 'Beta / devnet testing' },
  { value: 'live', label: 'Live product' },
  { value: 'revenue', label: 'Revenue-generating' },
  { value: 'growth', label: 'Scaling / growth' },
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number]['value'];
/** A failure whose message is safe to show the member or operator who caused it. */
export class BuilderError extends Error {}
/**
 * The signed-in public account as the store writes it: the stable account id,
 * the verified login email (null for a Telegram-only account or an unverified
 * address; the internal placeholder never appears here) and the display name.
 */
export type BuilderIdentity = { id: string; email: string | null; name: string };
/**
 * The stored public account. `contactEmail` is the optional, self-declared
 * address on the profile: read from hq_builder_profiles.contact_email, never
 * derived from the login address, and never written by an account sync.
 */
export type BuilderUser = BuilderIdentity & { contactEmail: string | null };
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
