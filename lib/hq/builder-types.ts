import type { ProjectSourceFields, SubmissionStatus } from "./colosseum-snapshot";

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

/** Match the configured country spelling case- and whitespace-insensitively. */
export const NETHERLANDS = 'Netherlands';
export const isNetherlands = (country: string | null | undefined): boolean =>
  typeof country === 'string' && country.trim().toLowerCase() === NETHERLANDS.toLowerCase();

/** HQ import gates; upstream/transport failures are mapped separately in project-import.ts. */
export type ImportRefusal =
  | 'edition_not_configured'
  | 'imports_closed'
  | 'not_dutch'
  | 'wrong_edition'
  | 'already_imported';

export const IMPORT_REFUSAL_MESSAGES: Record<ImportRefusal, string> = {
  edition_not_configured: 'Superteam NL has not confirmed this hackathon’s Colosseum edition yet, so imports are closed. Ask for help below and we will open them.',
  imports_closed: 'Project imports are not open yet. Your HQ account is ready; come back when Colosseum opens project access.',
  not_dutch: 'This project is not registered as a Netherlands project. Country is set on Colosseum, not in HQ: change it on your Colosseum project page, then import again.',
  wrong_edition: 'This project belongs to a different hackathon than the one HQ is running. Import the project you registered for this edition.',
  already_imported: 'This team is already in HQ.',
};

/** An import HQ refused on its own rules, carrying which rule so the screen can answer accurately. */
export class ImportRefusedError extends BuilderError {
  constructor(public readonly reason: ImportRefusal) {
    super(IMPORT_REFUSAL_MESSAGES[reason]);
    this.name = 'ImportRefusedError';
  }
}

/** Bearer-link failures reveal no team, member or inviter identity. */
export type JoinLinkRefusal = 'invalid' | 'expired' | 'used' | 'other_edition';

export const JOIN_LINK_MESSAGES: Record<JoinLinkRefusal, string> = {
  invalid: 'That is not a join link we recognise. Ask the teammate who invited you to send you a fresh one.',
  expired: 'This join link has expired. Ask the teammate who invited you for a new one.',
  used: 'This join link has already been used. If that was not you, ask your teammate for a new one.',
  other_edition: 'This join link is for a hackathon HQ is no longer running.',
};

/** The unclaimed roster a valid project link opens. Legacy links expose only their original seat. */
export type JoinProject = {
  id: string; projectId: string;
  projectName: string; projectUrl: string; hackathonId: number;
  members: { id: string; name: string; username: string; avatarUrl: string | null }[];
};

export type JoinLinkLookup = { ok: true; data: JoinProject } | { ok: false; reason: JoinLinkRefusal };
/** Verified login identity; Telegram-only or unverified email is null, never a placeholder. */
export type BuilderIdentity = { id: string; email: string | null; name: string };
/** Self-declared contact email is separate from login and never changed by account sync. */
export type BuilderUser = BuilderIdentity & { contactEmail: string | null };
export type BuilderHackathon = {
  id: number; name: string; startDate: string; endDate: string;
  externalId: number | null; externalSlug: string | null;
  projectsOpen: boolean; projectsAvailableAt: string | null;
  signupUrl: string;
};
/**
 * Stored source fields shared by member surfaces. Submission is separate from readiness;
 * failed source checks retain the last known state and record only freshness/error metadata.
 */
export type BuilderTeamSource = ProjectSourceFields & {
  submissionStatus: SubmissionStatus;
  completion: { isComplete: boolean; missingCount: number } | null;
  sourceStatus: 'never' | 'ok' | 'error';
  /** When the source was last read successfully. A failed check leaves it alone. */
  sourceCheckedAt: string | null;
  /** HQ's own ColosseumErrorCode from the last failure, never Colosseum's raw text. */
  sourceErrorCode: string | null;
};

export type BuilderTeam = {
  id: string; name: string; hackathonId: number; hackathonName: string;
  projectUrl: string; description: string; stage: ProjectStage;
  verification: 'pending' | 'verified' | 'rejected';
  ownerId: string; leadUsername: string;
  members: { id: string; name: string; username: string; avatarUrl: string | null; joined: boolean }[];
  source: BuilderTeamSource;
};
export type BuilderResult<T = Record<string, never>> =
  | { ok: true; data: T }
  | { ok: false; error: string };
