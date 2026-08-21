import "server-only";
import { CLASSIFIERS_SELECT, toClassifiers } from "./classifiers-sql";
import { getSql } from "./db";
import { attributeOutputs, type AttributableProject } from "./event-attribution";
import { fmtDate, normName, todayInTz } from "./format";
import type {
  ActivityItem,
  Award,
  Classifiers,
  DemoProject,
  EventOption,
  FinalistProject,
  HqEvent,
  HqLink,
  Judge,
  Milestone,
  Partner,
  PartnerDetail,
  PartnerOption,
  Person,
  Project,
  Role,
  Score,
  SearchResult,
  Settings,
} from "./types";

// Dates are cast to text in SQL so no driver/timezone parsing can shift them.

export async function getClassifiers(): Promise<Classifiers> {
  const sql = getSql();
  const [row] = await sql.query(CLASSIFIERS_SELECT);
  return toClassifiers(row ?? {});
}

const SETTING_KEYS: Record<string, keyof Settings> = {
  prospects_reached: "prospectsReached",
  prospects_target: "prospectsTarget",
  committed_manual: "committedManual",
  committed_target: "committedTarget",
  committed_glide: "committedGlide",
  active_at_kickoff: "activeAtKickoff",
  active_target: "activeTarget",
  verified_target: "verifiedTarget",
  stale_days: "staleDays",
  finalist_cap: "finalistCap",
  verified_only_finalists: "verifiedOnlyFinalists",
  timezone: "timezone",
  cal_start: "calStart",
  cal_end: "calEnd",
  prospects_sub: "prospectsSub",
  active_sub: "activeSub",
};

const SETTINGS_FALLBACK: Settings = {
  prospectsReached: 0,
  prospectsTarget: 0,
  committedManual: 0,
  committedTarget: 0,
  committedGlide: 0,
  activeAtKickoff: 0,
  activeTarget: 0,
  verifiedTarget: 0,
  staleDays: 7,
  finalistCap: 30,
  verifiedOnlyFinalists: false,
  timezone: "Europe/Amsterdam",
  calStart: "",
  calEnd: "",
  prospectsSub: "",
  activeSub: "",
};

export async function getSettings(): Promise<Settings> {
  const sql = getSql();
  const rows = await sql`SELECT key, value FROM hq_settings`;
  const settings = { ...SETTINGS_FALLBACK };
  for (const row of rows) {
    const prop = SETTING_KEYS[row.key as string];
    if (prop) (settings as Record<string, unknown>)[prop] = row.value;
  }
  return settings;
}

export async function getProjects(): Promise<Project[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT
      p.id, p.name, p.lead_name, p.lead_contact,
      p.partner_id, COALESCE(pa.name, '') AS partner_name,
      p.event_src, s.slug AS status_slug, f.slug AS forecast_slug,
      p.last_check_in::text AS last_check_in, p.blocker,
      COALESCE(u.display_name, '') AS touched_by, p.touched_at::text AS touched_at,
      COALESCE(
        (SELECT json_agg(json_build_object('id', m.id, 'name', m.name, 'contact', m.contact)
           ORDER BY m.sort, m.id)
         FROM hq_project_members m WHERE m.project_id = p.id),
        '[]'
      ) AS members,
      COALESCE(
        (SELECT array_agg(g.gate_id::text) FROM hq_project_gates g WHERE g.project_id = p.id),
        '{}'
      ) AS gates,
      COALESCE(
        (SELECT json_agg(json_build_object(
            'id', n.id,
            'author', COALESCE(au.display_name, ''),
            'body', n.body,
            'createdAt', to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ) ORDER BY n.created_at DESC)
          FROM hq_project_notes n
          LEFT JOIN hq_users au ON au.id = n.author_user_id
          WHERE n.project_id = p.id),
        '[]'
      ) AS notes
    FROM hq_projects p
    JOIN hq_project_statuses s ON s.id = p.status_id
    JOIN hq_project_forecasts f ON f.id = p.forecast_id
    LEFT JOIN hq_partners pa ON pa.id = p.partner_id
    LEFT JOIN hq_users u ON u.id = p.touched_by_user_id
    ORDER BY p.created_at DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    leadName: r.lead_name,
    leadContact: r.lead_contact,
    members: r.members ?? [],
    partnerId: r.partner_id,
    partnerName: r.partner_name,
    eventSrc: r.event_src,
    statusSlug: r.status_slug,
    forecastSlug: r.forecast_slug,
    lastCheckIn: r.last_check_in,
    blocker: r.blocker,
    touchedBy: r.touched_by,
    touchedAt: r.touched_at,
    gates: r.gates ?? [],
    notes: r.notes ?? [],
  }));
}

function mapPartner(r: Record<string, unknown>): Partner {
  return {
    id: r.id as string,
    name: r.name as string,
    channelId: r.channel_id as string,
    channelLabel: r.channel_label as string,
    captainName: r.captain_name as string,
    captainContact: r.captain_contact as string,
    stageSlug: r.stage_slug as string,
    target: r.target as number,
    exchange: (r.exchange as string[]) ?? [],
    touchedBy: (r.touched_by as string) ?? "",
    touchedAt: r.touched_at as string | null,
    attributed: Number(r.attributed ?? 0),
  };
}

const PARTNER_SELECT = /* sql */ `
  SELECT
    pa.id, pa.name, pa.channel_id, c.label AS channel_label,
    pa.captain_name, pa.captain_contact, st.slug AS stage_slug, pa.target,
    COALESCE(u.display_name, '') AS touched_by, pa.touched_at::text AS touched_at,
    COALESCE(
      (SELECT array_agg(x.item_id::text) FROM hq_partner_exchange x WHERE x.partner_id = pa.id),
      '{}'
    ) AS exchange,
    (SELECT count(*)::int FROM hq_projects pr WHERE pr.partner_id = pa.id) AS attributed
  FROM hq_partners pa
  JOIN hq_partner_channels c ON c.id = pa.channel_id
  JOIN hq_partner_stages st ON st.id = pa.stage_id
  LEFT JOIN hq_users u ON u.id = pa.touched_by_user_id
`;

export async function getPartners(): Promise<Partner[]> {
  const sql = getSql();
  const rows = await sql.query(`${PARTNER_SELECT} ORDER BY pa.created_at`);
  return (rows as Record<string, unknown>[]).map(mapPartner);
}

export async function getPartnerDetail(id: string): Promise<PartnerDetail | null> {
  const sql = getSql();
  const rows = await sql.query(`${PARTNER_SELECT} WHERE pa.id = $1`, [id]);
  const row = (rows as Record<string, unknown>[])[0];
  if (!row) return null;
  const [contacts, teams] = await Promise.all([
    sql`
      SELECT n.id, COALESCE(au.display_name, '') AS author, n.body,
        to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
      FROM hq_partner_contacts n
      LEFT JOIN hq_users au ON au.id = n.author_user_id
      WHERE n.partner_id = ${id}
      ORDER BY n.created_at DESC
    `,
    sql`
      SELECT p.id, p.name, s.slug AS status_slug
      FROM hq_projects p
      JOIN hq_project_statuses s ON s.id = p.status_id
      WHERE p.partner_id = ${id}
      ORDER BY p.created_at DESC
    `,
  ]);
  return {
    ...mapPartner(row),
    contacts: contacts.map((n) => ({
      id: n.id,
      author: n.author,
      body: n.body,
      createdAt: n.created_at,
    })),
    teams: teams.map((t) => ({ id: t.id, name: t.name, statusSlug: t.status_slug })),
  };
}

export async function getPeople(): Promise<Person[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT p.id, p.name, p.role_id, p.org, p.contact, p.partner_id,
      COALESCE(pa.name, '') AS partner_name, p.notes
    FROM hq_people p
    LEFT JOIN hq_partners pa ON pa.id = p.partner_id
    ORDER BY p.created_at DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    roleId: r.role_id,
    org: r.org,
    contact: r.contact,
    partnerId: r.partner_id,
    partnerName: r.partner_name,
    notes: r.notes,
  }));
}

/**
 * When the Luma mirror last refreshed, or null if it never has. Nothing
 * refreshes it during a page view any more — the hourly workflow is the only
 * scheduled writer — so this timestamp is the Events page's only evidence that
 * the schedule is still running.
 */
export async function getLumaSyncedAt(): Promise<string | null> {
  const sql = getSql();
  const [row] = await sql`SELECT last_success_at FROM hq_luma_sync WHERE id = true`;
  const at = row ? Date.parse(String(row.last_success_at)) : NaN;
  // The column defaults to the epoch, which means "never synced", not 1970.
  if (!Number.isFinite(at) || at <= 0) return null;
  return new Date(at).toISOString();
}

/**
 * Events with their derived outputs (qualified / active / verified-submission
 * counts). Mirrors the design: each project is attributed to the FIRST event
 * (by date) whose normalized name matches its event_src.
 */
export async function getEventsWithOutputs(): Promise<HqEvent[]> {
  const sql = getSql();
  const [events, projects, gateTotalRows] = await Promise.all([
    sql`
      SELECT id, name, date::text AS date, end_date::text AS end_date, type_id,
        venue, cohost, attendance, leads, spend,
        luma_id, luma_url, pinned_fields, archived_at, archived_reason
      FROM hq_events
      ORDER BY date, created_at
    `,
    sql`
      SELECT p.id, p.event_src, s.counts_as_active,
        (SELECT count(*)::int FROM hq_project_gates g WHERE g.project_id = p.id) AS gates_done
      FROM hq_projects p
      JOIN hq_project_statuses s ON s.id = p.status_id
    `,
    sql`SELECT count(*)::int AS total FROM hq_submission_gates`,
  ]);
  const gateTotal = Number(gateTotalRows[0]?.total ?? 0);

  const outputs = attributeOutputs(
    events.map((e) => ({ id: e.id, name: e.name, archived: Boolean(e.archived_at) })),
    projects as unknown as AttributableProject[],
    gateTotal,
  );

  return events.map((e) => ({
    id: e.id,
    name: e.name,
    date: e.date,
    endDate: e.end_date,
    typeId: e.type_id,
    venue: e.venue,
    cohost: e.cohost,
    attendance: e.attendance,
    leads: e.leads,
    spend: e.spend,
    lumaId: e.luma_id,
    lumaUrl: e.luma_url,
    pinned: (e.pinned_fields ?? []) as string[],
    archived: Boolean(e.archived_at),
    archivedReason: e.archived_reason,
    outputs: outputs.get(e.id) ?? { q: 0, a: 0, s: 0 },
  }));
}

export async function getAwards(): Promise<Award[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT id, name, sponsor, amount, winner_project_id
    FROM hq_awards
    ORDER BY sort, name
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sponsor: r.sponsor,
    amount: r.amount,
    winnerProjectId: r.winner_project_id,
  }));
}

export async function getFinalists(): Promise<FinalistProject[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT fi.project_id, fi.position, p.name,
      COALESCE(pa.name, '') AS partner_name, p.event_src,
      (SELECT count(*)::int FROM hq_project_gates g WHERE g.project_id = p.id) AS gates_done,
      (SELECT count(*)::int FROM hq_submission_gates) AS gates_total
    FROM hq_finalists fi
    JOIN hq_projects p ON p.id = fi.project_id
    LEFT JOIN hq_partners pa ON pa.id = p.partner_id
    ORDER BY fi.position, fi.project_id
  `;
  return rows.map((r) => ({
    projectId: r.project_id,
    position: r.position,
    name: r.name,
    source: [r.partner_name, r.event_src].filter(Boolean).join(", "),
    gatesDone: r.gates_done,
    gatesTotal: r.gates_total,
  }));
}

export async function getScores(): Promise<Score[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT id, judge_id, project_id, score, note
    FROM hq_scores
    ORDER BY created_at
  `;
  return rows.map((r) => ({
    id: r.id,
    judgeId: r.judge_id,
    projectId: r.project_id,
    score: r.score,
    note: r.note,
  }));
}

/**
 * Slim projection for the Demo Day screen: no contact details, blockers,
 * or note history ever reach that Client Component.
 */
export async function getDemoProjects(): Promise<DemoProject[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT p.id, p.name, COALESCE(pa.name, '') AS partner_name, p.event_src,
      (SELECT count(*)::int FROM hq_project_gates g WHERE g.project_id = p.id) AS gates_done
    FROM hq_projects p
    LEFT JOIN hq_partners pa ON pa.id = p.partner_id
    ORDER BY p.created_at DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    partnerName: r.partner_name,
    eventSrc: r.event_src,
    gatesDone: Number(r.gates_done),
  }));
}

/** People with a judging role — names only, for the score picker. */
export async function getJudges(): Promise<Judge[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT p.id, p.name FROM hq_people p
    JOIN hq_people_roles r ON r.id = p.role_id
    WHERE r.is_judge
    ORDER BY p.name
  `;
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

export async function getGatesTotal(): Promise<number> {
  const sql = getSql();
  const [row] = await sql`SELECT count(*)::int AS total FROM hq_submission_gates`;
  return Number(row?.total ?? 0);
}

/** Just the people roles, for screens that don't need the other classifiers. */
export async function getRoles(): Promise<Role[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT id, label, filter_label, color, bg, is_judge
    FROM hq_people_roles ORDER BY sort
  `;
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    filterLabel: r.filter_label,
    color: r.color,
    bg: r.bg,
    isJudge: r.is_judge,
  }));
}

/**
 * Event names for the project "source event" picker, earliest first.
 * Projects store the name (not an id) and are attributed to the first event
 * whose normalized name matches, so the list carries one entry per distinct
 * name — offering the same name twice would pick out the same event anyway.
 */
export async function getEventOptions(): Promise<EventOption[]> {
  const sql = getSql();
  const rows = await sql`SELECT id, name FROM hq_events ORDER BY date, created_at`;
  const seen = new Set<string>();
  const options: EventOption[] = [];
  for (const r of rows) {
    const key = normName(r.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    options.push({ id: r.id, name: r.name });
  }
  return options;
}

/** Shared links with their note logs, newest link first. */
export async function getLinks(): Promise<HqLink[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT l.id, l.title, l.url, l.highlighted,
      COALESCE(
        (SELECT json_agg(json_build_object(
            'id', n.id,
            'author', COALESCE(au.display_name, ''),
            'body', n.body,
            'createdAt', to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ) ORDER BY n.created_at DESC)
          FROM hq_link_notes n
          LEFT JOIN hq_users au ON au.id = n.author_user_id
          WHERE n.link_id = l.id),
        '[]'
      ) AS notes
    FROM hq_links l
    ORDER BY l.created_at DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    highlighted: r.highlighted,
    notes: r.notes ?? [],
  }));
}

/** Id/name pairs for partner dropdowns — no captain contact or metadata. */
export async function getPartnerOptions(): Promise<PartnerOption[]> {
  const sql = getSql();
  const rows = await sql`SELECT id, name FROM hq_partners ORDER BY created_at`;
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

export async function getActivity(limit = 40): Promise<ActivityItem[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT a.id::text AS id, COALESCE(u.display_name, '') AS user_name, a.message,
      to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
    FROM hq_activity a
    LEFT JOIN hq_users u ON u.id = a.user_id
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    user: r.user_name,
    message: r.message,
    createdAt: r.created_at,
  }));
}

export async function getMilestones(): Promise<Milestone[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT id, date::text AS date, label FROM hq_milestones ORDER BY date
  `;
  return rows.map((r) => ({ id: r.id, date: r.date, label: r.label }));
}

export async function searchAll(query: string): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const sql = getSql();
  // Escape LIKE metacharacters so % _ \ in a query match literally (a
  // trailing bare backslash would otherwise make Postgres reject the pattern).
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const [projects, partners, people, events] = await Promise.all([
    sql`
      SELECT id, name, lead_name FROM hq_projects
      WHERE name ILIKE ${like} OR lead_name ILIKE ${like}
      ORDER BY created_at DESC LIMIT 12
    `,
    sql`
      SELECT pa.id, pa.name, c.label AS channel FROM hq_partners pa
      JOIN hq_partner_channels c ON c.id = pa.channel_id
      WHERE pa.name ILIKE ${like} OR pa.captain_name ILIKE ${like}
      ORDER BY pa.created_at DESC LIMIT 12
    `,
    sql`
      SELECT p.id, p.name, r.label AS role, p.org FROM hq_people p
      JOIN hq_people_roles r ON r.id = p.role_id
      WHERE p.name ILIKE ${like} OR p.org ILIKE ${like}
      ORDER BY p.created_at DESC LIMIT 12
    `,
    sql`
      SELECT id, name, date::text AS date FROM hq_events
      WHERE name ILIKE ${like}
      ORDER BY date LIMIT 12
    `,
  ]);
  const results: SearchResult[] = [
    ...projects.map((r) => ({
      kind: "Project" as const,
      id: r.id as string,
      label: r.name as string,
      meta: r.lead_name as string,
    })),
    ...partners.map((r) => ({
      kind: "Partner" as const,
      id: r.id as string,
      label: r.name as string,
      meta: r.channel as string,
    })),
    ...people.map((r) => ({
      kind: "Person" as const,
      id: r.id as string,
      label: r.name as string,
      meta: [r.role, r.org].filter(Boolean).join(", "),
    })),
    ...events.map((r) => ({
      kind: "Event" as const,
      id: r.id as string,
      label: r.name as string,
      meta: fmtDate(r.date as string),
    })),
  ];
  return results.slice(0, 12);
}

/** Today in the campaign timezone — the stamp used by check-ins and touch(). */
export async function getToday(): Promise<string> {
  const settings = await getSettings();
  return todayInTz(settings.timezone);
}
