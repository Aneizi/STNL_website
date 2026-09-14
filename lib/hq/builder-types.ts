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
 * The country a project must be registered under on Colosseum for HQ to
 * import it. Compared case- and whitespace-insensitively because the value
 * is whatever the builder picked on Colosseum, not an HQ enum; the string
 * itself is the plan's, `project.country === "Netherlands"`.
 */
export const NETHERLANDS = 'Netherlands';
export const isNetherlands = (country: string | null | undefined): boolean =>
  typeof country === 'string' && country.trim().toLowerCase() === NETHERLANDS.toLowerCase();

/**
 * Why an import was refused by HQ itself, as opposed to by Colosseum. Every
 * one of these is a distinct, actionable outcome with its own wording: the
 * plan forbids collapsing any of them into a shared generic failure. The
 * transport and lookup failures (a malformed link, a 404, a timeout, a 429,
 * an unreadable body) keep their own `ColosseumErrorCode` and are mapped in
 * ./project-import.ts.
 */
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

/**
 * Why a join link cannot be used. Four separate outcomes, and **not one of
 * these messages names the team, its members or who created the link**: a
 * link is a bearer token, so someone holding a stale or guessed one must
 * learn nothing about the team behind it.
 */
export type JoinLinkRefusal = 'invalid' | 'expired' | 'used' | 'other_edition';

export const JOIN_LINK_MESSAGES: Record<JoinLinkRefusal, string> = {
  invalid: 'That is not a join link we recognise. Ask the teammate who invited you to send you a fresh one.',
  expired: 'This join link has expired. Ask the teammate who invited you for a new one.',
  used: 'This join link has already been used. If that was not you, ask your teammate for a new one.',
  other_edition: 'This join link is for a hackathon HQ is no longer running.',
};

/** The unclaimed roster seat a valid join link opens. Returned only once the link checks out. */
export type JoinSeat = {
  id: string; memberId: string; projectId: string;
  name: string; username: string; projectName: string; projectUrl: string; hackathonId: number;
};

export type JoinLinkLookup = { ok: true; data: JoinSeat } | { ok: false; reason: JoinLinkRefusal };
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
/**
 * The normalized Colosseum snapshot stored beside a team, as every surface
 * reads it. Submission and readiness are separate: `submissionStatus` comes
 * from `lib/hq/colosseum-snapshot.ts#interpretSubmission` and nothing else,
 * and `completion` is the readiness diagnostic that must never drive it.
 * `sourceStatus`/`sourceCheckedAt` are freshness, not truth about the
 * project: a failed check keeps the last known submission status.
 */
export type BuilderTeamSource = {
  category: string | null;
  tracks: string[];
  /** Source-labelled: a handle found on the Colosseum project, not necessarily the project's own account. */
  twitterHandle: string | null;
  website: string | null;
  repoLink: string | null;
  presentationLink: string | null;
  technicalDemoLink: string | null;
  pitchVideoLink: string | null;
  demoVideoLink: string | null;
  imageUrl: string | null;
  submissionStatus: 'not_checked' | 'submitted' | 'not_submitted';
  submittedAt: string | null;
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
