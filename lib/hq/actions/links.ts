"use server";

import { z } from "zod";
import { requireUser } from "../auth";
import { getSql } from "../db";
import { requireHackathon } from "../hackathon";
import { HIGHLIGHT_CAP } from "../types";
import type { ActionResult } from "../types";
import { activityStmt, refreshHq } from "./util";

const id = z.string().uuid();

type LinkRef = { title: string; hackathonId: number };

async function getLink(linkId: string): Promise<LinkRef | null> {
  const sql = getSql();
  const rows = await sql`SELECT title, hackathon_id FROM hq_links WHERE id = ${linkId}`;
  return rows[0] ? { title: rows[0].title, hackathonId: Number(rows[0].hackathon_id) } : null;
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  url: z.string().min(1).max(2000),
});

export async function createLink(input: z.infer<typeof createSchema>): Promise<ActionResult> {
  const user = await requireUser();
  const hackathon = await requireHackathon();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Title and link are required." };
  const title = parsed.data.title.trim();
  let url = parsed.data.url.trim();
  if (!title || !url) return { ok: false, error: "Title and link are required." };
  // Normalise here, not just in the form, so a pasted bare domain can never
  // store an unusable value.
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  const sql = getSql();
  await sql.transaction([
    sql`
      INSERT INTO hq_links (hackathon_id, title, url, touched_by_user_id, touched_at)
      VALUES (${hackathon.id}, ${title}, ${url}, ${user.id}, now())
    `,
    activityStmt(user.id, hackathon.id, `Added link ${title}`),
  ]);
  refreshHq();
  return { ok: true };
}

/**
 * Edits a link in place. Shares createLink's schema and the same bare-domain
 * normalisation, so an edited URL can never be less usable than a created one.
 * Highlight state and notes ride along untouched.
 */
export async function updateLink(
  linkId: string,
  input: z.infer<typeof createSchema>,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(linkId).success) return { ok: false };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Title and link are required." };
  const title = parsed.data.title.trim();
  let url = parsed.data.url.trim();
  if (!title || !url) return { ok: false, error: "Title and link are required." };
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const before = await getLink(linkId);
  if (!before) return { ok: false };

  const sql = getSql();
  await sql.transaction([
    sql`
      UPDATE hq_links
      SET title = ${title}, url = ${url},
          touched_by_user_id = ${user.id}, touched_at = now()
      WHERE id = ${linkId}
    `,
    activityStmt(user.id, before.hackathonId, `Edited link ${before.title}`),
  ]);
  refreshHq();
  return { ok: true };
}

export async function deleteLink(linkId: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(linkId).success) return { ok: false };
  const link = await getLink(linkId);
  if (!link) return { ok: false };

  const sql = getSql();
  await sql.transaction([
    sql`DELETE FROM hq_links WHERE id = ${linkId}`,
    activityStmt(user.id, link.hackathonId, `Deleted link ${link.title}`),
  ]);
  refreshHq();
  return { ok: true };
}

/**
 * Highlighting pins a link to the top of the list, capped at HIGHLIGHT_CAP per
 * hackathon. The cap is enforced inside the UPDATE so the count and the write
 * share one snapshot — the same contract addFinalist uses for finalistCap.
 */
export async function setLinkHighlighted(
  linkId: string,
  highlighted: boolean,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(linkId).success) return { ok: false };
  if (!z.boolean().safeParse(highlighted).success) return { ok: false };
  const link = await getLink(linkId);
  if (!link) return { ok: false };

  const sql = getSql();
  if (!highlighted) {
    await sql.transaction([
      sql`
        UPDATE hq_links
        SET highlighted = false, touched_by_user_id = ${user.id}, touched_at = now()
        WHERE id = ${linkId}
      `,
      activityStmt(user.id, link.hackathonId, `Removed highlight on ${link.title}`),
    ]);
    refreshHq();
    return { ok: true };
  }

  const updated = await sql`
    UPDATE hq_links
    SET highlighted = true, touched_by_user_id = ${user.id}, touched_at = now()
    WHERE id = ${linkId}
      AND (
        highlighted
        OR (SELECT count(*) FROM hq_links x
            WHERE x.highlighted AND x.hackathon_id = hq_links.hackathon_id) < ${HIGHLIGHT_CAP}::int
      )
    RETURNING id
  `;
  if (updated.length === 0) {
    return { ok: false, error: `Highlight limit reached - ${HIGHLIGHT_CAP} max` };
  }
  await activityStmt(user.id, link.hackathonId, `Highlighted ${link.title}`);
  refreshHq();
  return { ok: true };
}

export async function addLinkNote(linkId: string, body: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!id.safeParse(linkId).success) return { ok: false };
  const parsed = z.string().min(1).max(2000).safeParse(body);
  if (!parsed.success) return { ok: false };
  const link = await getLink(linkId);
  if (!link) return { ok: false };

  const sql = getSql();
  await sql.transaction([
    sql`
      INSERT INTO hq_link_notes (link_id, author_user_id, body)
      VALUES (${linkId}, ${user.id}, ${parsed.data})
    `,
    sql`
      UPDATE hq_links SET touched_by_user_id = ${user.id}, touched_at = now()
      WHERE id = ${linkId}
    `,
    activityStmt(user.id, link.hackathonId, `Note on ${link.title}`),
  ]);
  refreshHq();
  return { ok: true };
}
