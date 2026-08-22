// Shared shapes between server queries, server actions, and client screens.
// Dates are ISO strings: DATE columns as "YYYY-MM-DD", timestamps as full ISO.

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
  prospectsTarget: number;
  committedManual: number;
  committedTarget: number;
  committedGlide: number;
  activeAtKickoff: number;
  activeTarget: number;
  verifiedTarget: number;
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

export type HqLink = {
  id: string;
  title: string;
  url: string;
  highlighted: boolean;
  notes: NoteItem[]; // reuses the existing NoteItem shape
};

/**
 * Most links that can be highlighted (pinned to the top of the Links list).
 * A constant, not an hq_settings row — promote it only if it ever needs to
 * be operator-editable.
 */
export const HIGHLIGHT_CAP = 5;

export type Person = {
  id: string;
  name: string;
  roleId: string;
  org: string;
  contact: string;
  partnerId: string | null;
  partnerName: string;
  notes: string;
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
