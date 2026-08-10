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

export type NoteItem = { id: string; author: string; body: string; createdAt: string };

export type Project = {
  id: string;
  name: string;
  leadName: string;
  leadContact: string;
  members: string[];
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
  // Derived from tracked projects; each project counts once, at the first
  // event (by date) whose normalized name matches its event_src.
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
