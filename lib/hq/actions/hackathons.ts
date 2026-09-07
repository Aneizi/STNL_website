"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "../auth";
import { getSql } from "../db";
import {
  forgetHackathon,
  rememberHackathon,
  requireHackathon,
  selectedHackathonId,
} from "../hackathon";
import { slugify } from "../hackathon-format";
import { getHackathon, getHackathons } from "../queries";
import type { ActionResult } from "../types";
import { activityStmt, refreshHq } from "./util";

const id = z.string().uuid();
// An internal HQ edition ID. External Colosseum IDs are configured separately.
const hackathonId = z.number().int().min(1).max(999_999_999);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The picker's form (/hq/select): remember the choice and open the dashboard.
 * A plain form action, so the banners work before any JavaScript arrives.
 */
export async function chooseHackathon(formData: FormData): Promise<void> {
  await requireUser();
  const raw = Number(formData.get("hackathon"));
  const hackathon = hackathonId.safeParse(raw).success ? await getHackathon(raw) : null;
  if (!hackathon) redirect("/hq/select");
  await rememberHackathon(hackathon.id);
  refreshHq();
  redirect("/hq");
}

/** The chrome's switcher: remember the choice and stay on the current page. */
export async function switchHackathon(target: number): Promise<ActionResult> {
  await requireUser();
  if (!hackathonId.safeParse(target).success) return { ok: false };
  const hackathon = await getHackathon(target);
  if (!hackathon) return { ok: false, error: "That hackathon no longer exists." };
  await rememberHackathon(hackathon.id);
  refreshHq();
  return { ok: true };
}

const detailsSchema = z.object({
  name: z.string().min(1).max(120),
  startDate: isoDate,
  endDate: isoDate,
});

type HackathonDetails = z.infer<typeof detailsSchema>;

function parseDetails(
  input: HackathonDetails,
): { ok: true; name: string; startDate: string; endDate: string } | { ok: false; error: string } {
  const parsed = detailsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Name, start date and end date are required." };
  const name = parsed.data.name.trim();
  if (!name) return { ok: false, error: "Name, start date and end date are required." };
  if (parsed.data.endDate < parsed.data.startDate) {
    return { ok: false, error: "The end date must not be before the start date." };
  }
  return { ok: true, name, startDate: parsed.data.startDate, endDate: parsed.data.endDate };
}

/**
 * The slug keys artwork and seed data, so it never changes after creation;
 * a name clash gets a numeric suffix rather than failing.
 */
async function freeSlug(name: string): Promise<string> {
  const sql = getSql();
  const base = slugify(name) || "hackathon";
  const taken = new Set(
    (await sql`SELECT slug FROM hq_hackathons WHERE slug = ${base} OR slug LIKE ${`${base}-%`}`).map(
      (r) => String(r.slug),
    ),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A new edition uses an unused internal HQ ID, independent of its external
 * Colosseum mapping. It starts from the one being shown: the same submission
 * gates and the same targets, thresholds and timezone. Counters that measure
 * this edition's progress start at zero, the calendar window follows the new
 * dates, and the dashboard captions are cleared because they describe a
 * specific campaign. Everything else — partners, people, projects, events,
 * links, milestones, awards — starts empty: a separate CRM.
 *
 * With nothing chosen (a database with no hackathon yet, adding its first
 * from the picker) there is nothing to copy, and the edition starts from
 * the built-in setting defaults.
 */
export async function createHackathon(
  input: HackathonDetails & { id: number },
): Promise<ActionResult> {
  const user = await requireUser();
  const parsedId = hackathonId.safeParse(input?.id);
  if (!parsedId.success) return { ok: false, error: "The hackathon id must be a whole number." };
  const parsed = parseDetails(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { name, startDate, endDate } = parsed;
  const newId = parsedId.data;
  if (await getHackathon(newId)) {
    return { ok: false, error: `Hackathon id ${newId} is already in use.` };
  }

  const selectedId = await selectedHackathonId();
  const template =
    (selectedId ? await getHackathon(selectedId) : null) ?? (await getHackathons())[0] ?? null;

  const sql = getSql();
  const slug = await freeSlug(name);
  const calStart = JSON.stringify(startDate.slice(0, 7));
  const calEnd = JSON.stringify(endDate.slice(0, 7));
  const copies = template
    ? [
        sql`
          INSERT INTO hq_settings (hackathon_id, key, value)
          SELECT ${newId}::int, key, value FROM hq_settings
          WHERE hackathon_id = ${template.id}::int
            AND key NOT IN ('prospects_reached', 'committed_manual', 'active_at_kickoff',
                            'cal_start', 'cal_end', 'prospects_sub', 'active_sub')
        `,
        sql`
          INSERT INTO hq_submission_gates (hackathon_id, label, sort)
          SELECT ${newId}::int, label, sort FROM hq_submission_gates
          WHERE hackathon_id = ${template.id}::int
        `,
        activityStmt(user.id, template.id, `Created hackathon ${name}`),
      ]
    : [];
  try {
    await sql.transaction([
      sql`
        INSERT INTO hq_hackathons (id, slug, name, start_date, end_date)
        VALUES (${newId}, ${slug}, ${name}, ${startDate}, ${endDate})
      `,
      sql`
        INSERT INTO hq_settings (hackathon_id, key, value)
        VALUES (${newId}, 'cal_start', ${calStart}::jsonb),
               (${newId}, 'cal_end', ${calEnd}::jsonb)
      `,
      ...copies,
      activityStmt(user.id, newId, `Created hackathon ${name}`),
    ]);
  } catch {
    // The id check above raced another operator, or the dates failed the
    // table's own check.
    return { ok: false, error: `Hackathon id ${newId} is already in use.` };
  }
  refreshHq();
  return { ok: true };
}

/** Name and dates only: the internal HQ ID is stable and the slug keys artwork. */
export async function updateHackathon(
  target: number,
  input: HackathonDetails,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!hackathonId.safeParse(target).success) return { ok: false };
  const parsed = parseDetails(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const existing = await getHackathon(target);
  if (!existing) return { ok: false, error: "That hackathon no longer exists." };

  const sql = getSql();
  await sql.transaction([
    sql`
      UPDATE hq_hackathons
      SET name = ${parsed.name}, start_date = ${parsed.startDate}, end_date = ${parsed.endDate}
      WHERE id = ${target}
    `,
    activityStmt(user.id, target, `Updated hackathon ${parsed.name}`),
  ]);
  refreshHq();
  return { ok: true };
}

/**
 * Archiving is the normal way to retire an edition, and the only way: the end
 * date passing changes nothing, because demo day and the wrap-up can run
 * after the hackathon itself closes. An archived edition keeps everything and
 * can still be opened; it just moves out of the way in the picker and the
 * switcher. Unarchive reverses it.
 */
export async function archiveHackathon(target: number): Promise<ActionResult> {
  const user = await requireUser();
  return setArchived(user.id, target, true);
}

export async function unarchiveHackathon(target: number): Promise<ActionResult> {
  const user = await requireUser();
  return setArchived(user.id, target, false);
}

/** Shared body; both callers authenticate before reaching it. */
async function setArchived(
  userId: string,
  target: number,
  archived: boolean,
): Promise<ActionResult> {
  if (!hackathonId.safeParse(target).success) return { ok: false };
  const existing = await getHackathon(target);
  if (!existing) return { ok: false, error: "That hackathon no longer exists." };
  if (existing.archived === archived) return { ok: true };

  const sql = getSql();
  await sql.transaction([
    archived
      ? sql`UPDATE hq_hackathons SET archived_at = now() WHERE id = ${target}`
      : sql`UPDATE hq_hackathons SET archived_at = NULL WHERE id = ${target}`,
    activityStmt(
      userId,
      target,
      `${archived ? "Archived" : "Unarchived"} hackathon ${existing.name}`,
    ),
  ]);
  refreshHq();
  return { ok: true };
}

/**
 * Takes the whole CRM with it (every scoped table cascades), so the UI
 * two-step confirms it, and the last hackathon can never go: HQ has nothing
 * to show without one. Deleting the edition being shown sends the operator
 * back to the picker.
 */
export async function deleteHackathon(target: number): Promise<ActionResult> {
  await requireUser();
  if (!hackathonId.safeParse(target).success) return { ok: false };

  const sql = getSql();
  const existing = await getHackathon(target);
  if (!existing) return { ok: true };
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM hq_hackathons`;
  if (Number(count) <= 1) {
    return { ok: false, error: "HQ needs at least one hackathon. Add another before deleting this one." };
  }
  await sql`DELETE FROM hq_hackathons WHERE id = ${target}`;
  const wasCurrent = (await selectedHackathonId()) === target;
  if (wasCurrent) await forgetHackathon();
  refreshHq();
  if (wasCurrent) redirect("/hq/select");
  return { ok: true };
}

/* ── Submission gates: each hackathon's own checklist ─────────────── */

const gateLabel = z.string().min(1).max(200);

export async function addGate(label: string): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = gateLabel.safeParse(label);
  const trimmed = parsed.success ? parsed.data.trim() : "";
  if (!trimmed) return { ok: false, error: "A gate needs a label." };

  const sql = getSql();
  try {
    await sql.transaction([
      sql`
        INSERT INTO hq_submission_gates (hackathon_id, label, sort)
        SELECT ${hackathon.id}::int, ${trimmed}::text, COALESCE(max(sort), -1) + 1
        FROM hq_submission_gates WHERE hackathon_id = ${hackathon.id}::int
      `,
      activityStmt(user.id, hackathon.id, `Added gate ${trimmed}`),
    ]);
  } catch {
    return { ok: false, error: "That gate already exists." };
  }
  refreshHq();
  return { ok: true };
}

async function gateRef(gateId: string): Promise<{ label: string; hackathonId: number } | null> {
  const sql = getSql();
  const rows = await sql`SELECT label, hackathon_id FROM hq_submission_gates WHERE id = ${gateId}`;
  return rows[0] ? { label: rows[0].label, hackathonId: Number(rows[0].hackathon_id) } : null;
}

export async function renameGate(gateId: string, label: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(gateId).success) return { ok: false };
  const parsed = gateLabel.safeParse(label);
  const trimmed = parsed.success ? parsed.data.trim() : "";
  if (!trimmed) return { ok: false, error: "A gate needs a label." };
  const gate = await gateRef(gateId);
  if (!gate) return { ok: false };
  if (gate.label === trimmed) return { ok: true };

  const sql = getSql();
  try {
    await sql.transaction([
      sql`UPDATE hq_submission_gates SET label = ${trimmed} WHERE id = ${gateId}`,
      activityStmt(user.id, gate.hackathonId, `Renamed gate ${gate.label} to ${trimmed}`),
    ]);
  } catch {
    return { ok: false, error: "That gate already exists." };
  }
  refreshHq();
  return { ok: true };
}

/** Ticks on this gate go with it (hq_project_gates cascades). */
export async function deleteGate(gateId: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(gateId).success) return { ok: false };
  const gate = await gateRef(gateId);
  if (!gate) return { ok: false };

  const sql = getSql();
  await sql.transaction([
    sql`DELETE FROM hq_submission_gates WHERE id = ${gateId}`,
    activityStmt(user.id, gate.hackathonId, `Removed gate ${gate.label}`),
  ]);
  refreshHq();
  return { ok: true };
}
