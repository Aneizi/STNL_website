// The reset is destructive and runs against the live database, so the split
// between what it clears and what it preserves is pinned down here rather than
// trusted. Runs the real RESET_STATEMENTS against PGlite, on a database seeded
// with a row in every table the manifest names.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CLEAR_TABLES,
  KEEP_TABLES,
  RESET_STATEMENTS,
} from "@/scripts/hq/reset-statements";
import { applyUpgrades } from "@/scripts/hq/upgrades";
import { applySqlFile } from "./helpers/db";

const SCHEMA = readFileSync(join(process.cwd(), "scripts/hq/schema.sql"), "utf8");

type Row = Record<string, unknown>;

let pg: PGlite;

async function run(text: string, params: unknown[] = []): Promise<Row[]> {
  return (await pg.query(text, params)).rows as Row[];
}

async function count(table: string): Promise<number> {
  const [row] = await run(`SELECT count(*)::int AS n FROM ${table}`);
  return Number(row.n);
}

async function id(text: string): Promise<string> {
  const [row] = await run(text);
  return String(row.id);
}

/** A row in every table the manifest touches, so nothing is vacuously "kept". */
async function seedEverything() {
  await run(
    `INSERT INTO hq_users (username, display_name, password_hash)
     VALUES ('cap','Cap','x') RETURNING id`,
  );
  const user = await id(`SELECT id FROM hq_users LIMIT 1`);
  await run(
    `INSERT INTO hq_sessions (user_id, expires_at) VALUES ($1, now() + interval '1 day')`,
    [user],
  );
  await run(`INSERT INTO hq_login_attempts (username, ip, success) VALUES ('cap','1.2.3.4',true)`);
  await run(`INSERT INTO hq_login_limits (key, count, window_start) VALUES ('cap',1,now())`);

  await run(`INSERT INTO hq_auth_user (id, name, email) VALUES ('member-1','Member','member@example.com')`);
  await run(`INSERT INTO hq_auth_session (id, "expiresAt", token, "userId")
             VALUES ('session-1', now() + interval '1 day', 'token-1', 'member-1')`);
  await run(`INSERT INTO hq_auth_account (id, issuer, "accountId", "providerId", "userId")
             VALUES ('account-1', 'https://oauth.telegram.org', '1234123412341234123', 'telegram', 'member-1')`);
  await run(`INSERT INTO hq_auth_telegram_identity (user_id, provider_subject, telegram_user_id)
             VALUES ('member-1', '1234123412341234123', 7000000000123)`);
  await run(`INSERT INTO hq_auth_verification (id, identifier, value, "expiresAt")
             VALUES ('verification-1', 'sign-in-otp:member@example.com', 'hash:0', now() + interval '5 minutes')`);
  await run(`INSERT INTO hq_auth_rate_limit (id, key, count, "lastRequest") VALUES ('limit-1', '1.2.3.4/sign-in', 1, 0)`);

  const hackathon = await id(
    `INSERT INTO hq_hackathons (id, slug, name, start_date, end_date)
     VALUES (6,'wf','World''s Fair','2026-09-14','2026-10-12') RETURNING id`,
  );
  await run(`INSERT INTO hq_partner_channels (label, sort) VALUES ('Direct',0)`);
  await run(`INSERT INTO hq_event_types (label, supports_end_date, sort) VALUES ('Other',false,0)`);
  await run(`INSERT INTO hq_people_roles (label, filter_label, color, bg, is_judge, sort)
             VALUES ('Judge','Judges','indigo','fill-3',true,0)`);
  await run(`INSERT INTO hq_partner_stages (slug,label,drop_color,sort) VALUES ('lead','Lead','g',0)`);
  await run(`INSERT INTO hq_project_statuses (slug,label,color,counts_as_active,sort)
             VALUES ('green','Green','green',true,0)`);
  await run(`INSERT INTO hq_project_forecasts (slug,label,color,sort)
             VALUES ('committed','Committed','green',0)`);
  await run(`INSERT INTO hq_submission_gates (hackathon_id, label, sort) VALUES ('${hackathon}','G1',0)`);
  await run(`INSERT INTO hq_exchange_items (slug,label,sort) VALUES ('swag','Swag',0)`);
  await run(`INSERT INTO hq_settings (hackathon_id,key,value)
             VALUES ('${hackathon}','timezone','"Europe/Amsterdam"')`);
  await run(`INSERT INTO hq_milestones (hackathon_id,date,label)
             VALUES ('${hackathon}',current_date,'Kickoff')`);

  const channel = await id(`SELECT id FROM hq_partner_channels LIMIT 1`);
  const stage = await id(`SELECT id FROM hq_partner_stages LIMIT 1`);
  const status = await id(`SELECT id FROM hq_project_statuses LIMIT 1`);
  const forecast = await id(`SELECT id FROM hq_project_forecasts LIMIT 1`);
  const role = await id(`SELECT id FROM hq_people_roles LIMIT 1`);
  const type = await id(`SELECT id FROM hq_event_types LIMIT 1`);
  const gate = await id(`SELECT id FROM hq_submission_gates LIMIT 1`);
  const item = await id(`SELECT id FROM hq_exchange_items LIMIT 1`);

  const partner = await id(
    `INSERT INTO hq_partners (hackathon_id, name, channel_id, stage_id)
     VALUES ('${hackathon}','P','${channel}','${stage}') RETURNING id`,
  );
  const project = await id(
    `INSERT INTO hq_projects (hackathon_id, name, status_id, forecast_id, last_check_in, partner_id)
     VALUES ('${hackathon}','Proj','${status}','${forecast}',current_date,'${partner}') RETURNING id`,
  );
  const person = await id(
    `INSERT INTO hq_people (hackathon_id, name, role_id)
     VALUES ('${hackathon}','Judge One','${role}') RETURNING id`,
  );
  await run(`INSERT INTO hq_events (hackathon_id,name,date,type_id)
             VALUES ('${hackathon}','Ev',current_date,'${type}')`);
  await run(`INSERT INTO hq_project_gates (project_id, gate_id) VALUES ('${project}','${gate}')`);
  await run(`INSERT INTO hq_project_notes (project_id, body) VALUES ('${project}','note')`);
  await run(`INSERT INTO hq_partner_exchange (partner_id, item_id) VALUES ('${partner}','${item}')`);
  await run(`INSERT INTO hq_partner_contacts (partner_id, body) VALUES ('${partner}','hi')`);
  await run(`INSERT INTO hq_finalists (project_id, hackathon_id, position)
             VALUES ('${project}','${hackathon}',1)`);
  await run(`INSERT INTO hq_scores (judge_id, project_id, score) VALUES ('${person}','${project}',8)`);
  await run(`INSERT INTO hq_awards (hackathon_id, name, sponsor, amount, winner_project_id, sort)
             VALUES ('${hackathon}','Best','S',100,'${project}',0)`);
  await run(`INSERT INTO hq_activity (hackathon_id, user_id, message)
             VALUES ('${hackathon}','${user}','did a thing')`);
  await run(`INSERT INTO hq_project_members (project_id, name, contact, sort)
             VALUES ('${project}','Teammate','tm@example.com',1)`);
  const link = await id(
    `INSERT INTO hq_links (hackathon_id, title, url)
     VALUES ('${hackathon}','Form','https://x.y') RETURNING id`,
  );
  await run(`INSERT INTO hq_link_notes (link_id, author_user_id, body)
             VALUES ('${link}','${user}','note')`);

  // Public account side: one account, its CRM person, and a row in every
  // builder table so nothing there is kept or cleared vacuously.
  await run(`INSERT INTO hq_builder_profiles (id, email, name) VALUES ('builder-1', 'builder@example.com', 'Builder')`);
  await run(`INSERT INTO hq_crm_persons (display_name, builder_user_id) VALUES ('Builder', 'builder-1')`);
  await run(`INSERT INTO hq_hackathon_onboarding (hackathon_id, external_hackathon_id, external_hackathon_slug)
             VALUES ('${hackathon}', 6, 'fictional-edition')`);
  await run(`INSERT INTO hq_builder_enrollments (user_id, hackathon_id) VALUES ('builder-1', '${hackathon}')`);
  await run(`INSERT INTO hq_project_onboarding (project_id, hackathon_id, external_id, project_url, slug, raw, owner_user_id, lead_username)
             VALUES ('${project}', '${hackathon}', 90001, 'https://colosseum.com/arena/projects/explore/tulip-ledger', 'tulip-ledger', '{}', 'builder-1', 'fictional_builder_1')`);
  const member = await id(`SELECT id FROM hq_project_members LIMIT 1`);
  await run(`INSERT INTO hq_team_invites (project_id, member_id, created_by, token_hash)
             VALUES ('${project}', '${member}', 'builder-1', 'fictional-token-hash')`);
  await run(`INSERT INTO hq_project_import_requests (user_id, hackathon_id, project_url)
             VALUES ('builder-1', '${hackathon}', 'https://colosseum.com/arena/projects/explore/unlisted')`);
  await run(`INSERT INTO hq_event_host_requests (user_id, hackathon_id, title, details)
             VALUES ('builder-1', '${hackathon}', 'Meetup', 'A fictional workshop')`);
  // A Captain grant and the audit event behind it (task T1.2).
  await run(`INSERT INTO hq_account_capabilities (user_id, capability, granted_by_user_id, reason)
             VALUES ('builder-1', 'captain', '${user}', 'seeded for the reset test')`);
  await run(`INSERT INTO hq_audit_events (kind, actor_kind, actor_id, subject_user_id, metadata)
             VALUES ('capability.granted', 'operator', '${user}', 'builder-1', '{"capability":"captain"}')`);
  // The account's bot-messaging decision (task T2.3), which survives like the login it belongs to.
  await run(`INSERT INTO hq_telegram_bot_consent (user_id, telegram_user_id, messaging_enabled, consented_at)
             VALUES ('builder-1', 7000000000123, true, now())`);
  // A Captain invitation, its redemption, and the resulting project assignment (task T4.1).
  const invitation = await id(
    `INSERT INTO hq_captain_invitations (token_hash, capability, max_redemptions, expires_at, created_by_user_id)
     VALUES ('fictional-invitation-hash', 'captain', 1, now() + interval '7 days', '${user}') RETURNING id`,
  );
  await run(`INSERT INTO hq_captain_invitation_redemptions (invitation_id, user_id) VALUES ('${invitation}', 'builder-1')`);
  await run(`INSERT INTO hq_captain_assignments (project_id, captain_user_id, assigned_by_user_id)
             VALUES ('${project}', 'builder-1', '${user}')`);
}

beforeEach(async () => {
  pg = new PGlite();
  for (const statement of SCHEMA.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) {
    await run(statement);
  }
  await applyUpgrades({ query: (text) => run(text) as Promise<Record<string, unknown>[]> });
  // The public account and builder tables are classified too, so they have to exist here.
  await applySqlFile(pg, "member-auth-schema.sql");
  await applySqlFile(pg, "builder-schema.sql");
  await seedEverything();
});

async function reset() {
  for (const text of RESET_STATEMENTS) await run(text);
}

describe("hq:reset", () => {
  it("starts from a database where every listed table has a row", async () => {
    // Guards the tests below: a table that was empty to begin with would pass
    // the "kept" assertions without proving anything.
    for (const table of [...CLEAR_TABLES, ...KEEP_TABLES]) {
      expect(await count(table), `${table} should be seeded`).toBeGreaterThan(0);
    }
  });

  it("clears every table on the clear list", async () => {
    await reset();
    for (const table of CLEAR_TABLES) {
      expect(await count(table), `${table} should be empty`).toBe(0);
    }
  });

  it("leaves logins, hackathons, classifiers, settings and campaign setup intact", async () => {
    await reset();
    for (const table of KEEP_TABLES) {
      expect(await count(table), `${table} should survive`).toBeGreaterThan(0);
    }
  });

  it("keeps everyone logged in", async () => {
    await reset();
    expect(await count("hq_users")).toBe(1);
    expect(await count("hq_sessions")).toBe(1);
  });

  it("keeps awards but clears the winner that no longer exists", async () => {
    await reset();
    const [award] = await run(`SELECT name, winner_project_id FROM hq_awards`);
    expect(award.name).toBe("Best");
    expect(award.winner_project_id).toBeNull();
  });

  it("rewinds the Luma throttle so the calendar re-mirrors immediately", async () => {
    await run(`UPDATE hq_luma_sync SET last_success_at = now()`);
    await reset();
    const [row] = await run(`SELECT last_success_at FROM hq_luma_sync`);
    expect(new Date(String(row.last_success_at)).getUTCFullYear()).toBe(1970);
  });

  it("is safe to run twice", async () => {
    await reset();
    await expect(reset()).resolves.not.toThrow();
    for (const table of CLEAR_TABLES) expect(await count(table)).toBe(0);
  });

  it("names every table in the schema as either cleared or kept", async () => {
    // A table added later that nobody classified would silently survive a
    // reset, which is how stale data creeps back into a "fresh" database.
    const listed = new Set<string>([...CLEAR_TABLES, ...KEEP_TABLES, "hq_luma_sync"]);
    const tables = (
      await run(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name LIKE 'hq_%'`,
      )
    ).map((r) => String(r.table_name));

    expect(tables.filter((t) => !listed.has(t))).toEqual([]);
  });
});
