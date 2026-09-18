// Shared shapes between server queries, server actions, and client screens.
// Dates are ISO strings: DATE columns as "YYYY-MM-DD", timestamps as full ISO.
import type { PersonRemovalImpact } from "./record-deletion";

export type Channel = { id: string; label: string };
export type EventType = { id: string; label: string; supportsEndDate: boolean };
export type Role = {
  id: string;
  label: string;
  filterLabel: string;
  color: string; // design token key, rendered as var(--<key>)
  bg: string;
  isJudge: boolean;
};
export type Stage = { id: string; slug: string; label: string; dropColor: string };
export type Status = {
  id: string;
  slug: string;
  label: string;
  color: string;
  countsAsActive: boolean;
};
export type Forecast = { id: string; slug: string; label: string; color: string };
export type Gate = { id: string; label: string };
export type ExchangeItem = { id: string; slug: string; label: string };

/**
 * One hackathon edition. Every operational record belongs to exactly one, and
 * the app only ever shows one at a time (chosen on /hq/select, remembered in
 * a cookie). The id is Colosseum's hackathon id (World's Fair is 6), typed in
 * when the edition is added. slug is stable and keys the banner artwork in
 * lib/hq/hackathon-art.ts; name and dates are operator-editable. archived is
 * only ever set by hand — an edition's end date passing changes nothing.
 */
export type Hackathon = {
  id: number;
  slug: string;
  name: string;
  startDate: string; // "YYYY-MM-DD"
  endDate: string;
  archived: boolean;
};

export type Classifiers = {
  channels: Channel[];
  eventTypes: EventType[];
  roles: Role[];
  stages: Stage[];
  statuses: Status[];
  forecasts: Forecast[];
  gates: Gate[];
  exchangeItems: ExchangeItem[];
};

export type Settings = {
  prospectsReached: number;
  committedManual: number;
  activeAtKickoff: number;
  staleDays: number;
  finalistCap: number;
  verifiedOnlyFinalists: boolean;
  timezone: string;
  calStart: string; // "YYYY-MM"
  calEnd: string;
  prospectsSub: string;
  activeSub: string;
};

// `editedAt` only rides along on the project timeline, the one note list whose
// entries can be rewritten after the fact. It holds the last edit alone, in
// the same shape as createdAt, and stays null until a note is rewritten.
export type NoteItem = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  editedAt?: string | null;
};

/** Individually editable teammate; the lead lives on the project itself. */
export type ProjectMember = { id: string; name: string; contact: string };

export type Project = {
  id: string;
  name: string;
  leadName: string;
  leadContact: string;
  members: ProjectMember[];
  partnerId: string | null;
  partnerName: string;
  /** The account holding the project's current Captain assignment, or null for "No Captain". Never a role or a tag — the one source is hq_captain_assignments. */
  captainUserId: string | null;
  captainName: string;
  eventSrc: string;
  statusSlug: string;
  forecastSlug: string;
  gates: string[]; // checked gate ids
  lastCheckIn: string;
  blocker: string;
  touchedBy: string;
  touchedAt: string | null;
  notes: NoteItem[];
};

export type Partner = {
  id: string;
  name: string;
  channelId: string;
  channelLabel: string;
  captainName: string;
  captainContact: string;
  stageSlug: string;
  target: number;
  exchange: string[]; // checked exchange item ids
  touchedBy: string;
  touchedAt: string | null;
  attributed: number;
};

export type PartnerDetail = Partner & {
  contacts: NoteItem[];
  teams: Array<{ id: string; name: string; statusSlug: string }>;
};

/**
 * A label on a People card. A role tag is the card's editable role. A
 * capability tag mirrors an admin-granted account capability (Captain): it is
 * not editable as a tag, marked protected, and never a way to grant anything.
 * Captain changes go through the card's Captain control (setPersonCaptain in
 * lib/hq/actions/people.ts), an explicit action on the linked account.
 */
export type PersonTag = { kind: "role" | "capability"; label: string; protected: boolean };

/** How a card's linked account signs in, for the Account block. The placeholder address is never in `email`. */
export type PersonAccount = { email: string | null; telegramUsername: string | null };

export type Person = {
  id: string;
  name: string;
  roleId: string;
  /**
   * The one contact the row shows, Telegram first: the linked account's
   * handle as "@handle", else what the card stores (a hand-entered handle or
   * email), else the account's login email, else "".
   */
  contact: string;
  notes: string;
  /** The linked public account, or null for a hand-entered card. */
  builderUserId: string | null;
  /** The CRM person this card belongs to, or null before one is assigned. */
  personId: string | null;
  /** The linked account's login, or null for a hand-entered card. */
  account: PersonAccount | null;
  /** Whether the linked account holds an active Captain grant. Read from hq_account_capabilities with the tags, never from a role. */
  captain: boolean;
  tags: PersonTag[];
  /**
   * What deleting this card takes with it, read before the destructive step
   * so the confirmation can name real counts (phase 3). Operator-only, like
   * the rest of this shape; `PublicPersonView` carries none of it.
   */
  removal: PersonRemovalImpact;
};

export type HqEvent = {
  id: string;
  name: string;
  date: string;
  endDate: string | null;
  typeId: string;
  venue: string;
  cohost: string;
  attendance: number;
  leads: number;
  spend: number;
  /** Luma calendar id, or null for an event added by hand in HQ. */
  lumaId: string | null;
  lumaUrl: string;
  /** Column names of Luma-backed fields an HQ edit has pinned. */
  pinned: string[];
  archived: boolean;
  /** 'manual' survives every sync; 'missing' clears if the event returns. */
  archivedReason: "manual" | "missing" | null;
  // Derived from tracked projects; each project counts once, at the first
  // event (by date) whose normalized name matches its event_src. Active
  // events claim a name ahead of archived ones.
  outputs: { q: number; a: number; s: number };
};

export type Award = {
  id: string;
  name: string;
  sponsor: string;
  amount: number;
  winnerProjectId: string | null;
};

export type FinalistProject = {
  projectId: string;
  position: number;
  name: string;
  source: string; // "partner, event" per design
  gatesDone: number;
  gatesTotal: number;
};

export type Score = {
  id: string;
  judgeId: string;
  projectId: string;
  score: number;
  note: string;
};

// Slim projections so client screens receive only what they render
// (contact details, blockers, and note history stay server-side).
export type DemoProject = {
  id: string;
  name: string;
  partnerName: string;
  eventSrc: string;
  gatesDone: number;
};

export type Judge = { id: string; name: string };

export type PartnerOption = { id: string; name: string };

export type EventOption = { id: string; name: string };

export type ActivityItem = {
  id: string;
  user: string;
  message: string;
  createdAt: string;
};

export type Milestone = { id: string; date: string; label: string };

export type SearchResult = {
  kind: "Project" | "Partner" | "Person" | "Event";
  id: string;
  label: string;
  meta: string;
};

// Standard server-action result for useActionState forms.
export type ActionResult = { ok: boolean; error?: string };
