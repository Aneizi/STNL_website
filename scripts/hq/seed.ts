// Seeds classifiers, campaign config, and the operator accounts.
// Generic app taxonomy (event types, roles, stages, statuses, forecasts,
// exchange items) lives here; campaign-specific data (operator accounts,
// partner channels, submission gates, awards, milestones, targets) is read
// from scripts/hq/seed-data.json, which is gitignored so none of it enters
// the public repository — copy seed-data.example.json to get started.
// Idempotent: classifiers upsert by label/slug, settings/milestones/awards
// only fill empty state, and existing users are never touched unless
// --reset-passwords is passed. Temp passwords are generated here and
// printed ONCE — they are never stored in plaintext or committed.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { createSql } from "../../lib/hq/db";
import { loadEnvLocal, requireEnv } from "./env";

const seedDataSchema = z.object({
  users: z.array(
    z.object({
      username: z.string().min(1).max(64),
      displayName: z.string().min(1).max(100),
    }),
  ),
  partnerChannels: z.array(z.string().min(1)),
  submissionGates: z.array(z.string().min(1)),
  awards: z.array(
    z.object({
      name: z.string().min(1),
      sponsor: z.string(),
      amount: z.number().int().min(0),
    }),
  ),
  milestones: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      label: z.string().min(1),
    }),
  ),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

type SeedData = z.infer<typeof seedDataSchema>;

function loadSeedData(): SeedData {
  let raw: string;
  try {
    raw = readFileSync(join(process.cwd(), "scripts/hq/seed-data.json"), "utf8");
  } catch {
    console.error(
      "Missing scripts/hq/seed-data.json (gitignored so campaign data stays " +
        "out of the public repo).\nCopy scripts/hq/seed-data.example.json to " +
        "seed-data.json and fill in real values.",
    );
    process.exit(1);
  }
  const parsed = seedDataSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.error("Invalid scripts/hq/seed-data.json:");
    console.error(parsed.error.message);
    process.exit(1);
  }
  return parsed.data;
}

const EVENT_TYPES: Array<[label: string, supportsEndDate: boolean]> = [
  ["Multi-day program", true],
  ["Weekly coworking", false],
  ["Workshop", false],
  ["Pitch session", false],
  ["Demo day", false],
  ["Online session", false],
  ["Community mixer", false],
  ["External event presence", false],
  ["Sponsored hackathon track", false],
  ["Other", false],
];

const PEOPLE_ROLES: Array<
  [label: string, filterLabel: string, color: string, bg: string, isJudge: boolean]
> = [
  ["Captain", "Captains", "accent", "accent-fill", false],
  ["Judge", "Judges", "indigo", "fill-3", true],
  ["Mentor", "Mentors", "green", "green-fill", false],
  ["Sponsor", "Sponsors", "orange", "orange-fill", false],
  ["Other", "Other", "label-2", "fill-4", false],
];

const PARTNER_STAGES: Array<[slug: string, label: string, dropColor: string]> = [
  ["draft", "Draft", "#8a8579"],
  ["sent", "Sent", "#a8760f"],
  ["call", "Called", "#ee5b23"],
  ["agreed", "Agreed", "#3e7c4f"],
  ["rejected", "Rejected", "#c03b2d"],
];

const PROJECT_STATUSES: Array<
  [slug: string, label: string, color: string, countsAsActive: boolean]
> = [
  ["green", "Green", "green", true],
  ["amber", "Amber", "orange", true],
  ["red", "Red", "red", false],
];

const PROJECT_FORECASTS: Array<[slug: string, label: string, color: string]> = [
  ["committed", "Committed", "green"],
  ["likely", "Likely", "orange"],
  ["at_risk", "At risk", "red"],
];

const EXCHANGE_ITEMS: Array<[slug: string, label: string]> = [
  ["mailing", "Mailing sent to their list"],
  ["event", "Event cohosted"],
  ["captain", "Captain named"],
  ["weekly", "Weekly follow-up active"],
];

function tempPassword(): string {
  // 12 chars of base64url ≈ 72 bits — plenty for a one-use temp password.
  return randomBytes(9).toString("base64url");
}

async function main() {
  loadEnvLocal();
  const data = loadSeedData();
  const sql = createSql(requireEnv("DATABASE_URL_UNPOOLED"));
  const resetPasswords = process.argv.includes("--reset-passwords");

  for (const [i, label] of data.partnerChannels.entries()) {
    await sql`INSERT INTO hq_partner_channels (label, sort) VALUES (${label}, ${i})
      ON CONFLICT (label) DO UPDATE SET sort = ${i}`;
  }
  for (const [i, [label, supportsEndDate]] of EVENT_TYPES.entries()) {
    await sql`INSERT INTO hq_event_types (label, supports_end_date, sort)
      VALUES (${label}, ${supportsEndDate}, ${i})
      ON CONFLICT (label) DO UPDATE SET supports_end_date = ${supportsEndDate}, sort = ${i}`;
  }
  for (const [i, [label, filterLabel, color, bg, isJudge]] of PEOPLE_ROLES.entries()) {
    await sql`INSERT INTO hq_people_roles (label, filter_label, color, bg, is_judge, sort)
      VALUES (${label}, ${filterLabel}, ${color}, ${bg}, ${isJudge}, ${i})
      ON CONFLICT (label) DO UPDATE
      SET filter_label = ${filterLabel}, color = ${color}, bg = ${bg}, is_judge = ${isJudge}, sort = ${i}`;
  }
  for (const [i, [slug, label, dropColor]] of PARTNER_STAGES.entries()) {
    await sql`INSERT INTO hq_partner_stages (slug, label, drop_color, sort)
      VALUES (${slug}, ${label}, ${dropColor}, ${i})
      ON CONFLICT (slug) DO UPDATE SET label = ${label}, drop_color = ${dropColor}, sort = ${i}`;
  }
  for (const [i, [slug, label, color, active]] of PROJECT_STATUSES.entries()) {
    await sql`INSERT INTO hq_project_statuses (slug, label, color, counts_as_active, sort)
      VALUES (${slug}, ${label}, ${color}, ${active}, ${i})
      ON CONFLICT (slug) DO UPDATE
      SET label = ${label}, color = ${color}, counts_as_active = ${active}, sort = ${i}`;
  }
  for (const [i, [slug, label, color]] of PROJECT_FORECASTS.entries()) {
    await sql`INSERT INTO hq_project_forecasts (slug, label, color, sort)
      VALUES (${slug}, ${label}, ${color}, ${i})
      ON CONFLICT (slug) DO UPDATE SET label = ${label}, color = ${color}, sort = ${i}`;
  }
  for (const [i, label] of data.submissionGates.entries()) {
    await sql`INSERT INTO hq_submission_gates (label, sort) VALUES (${label}, ${i})
      ON CONFLICT (label) DO UPDATE SET sort = ${i}`;
  }
  for (const [i, [slug, label]] of EXCHANGE_ITEMS.entries()) {
    await sql`INSERT INTO hq_exchange_items (slug, label, sort) VALUES (${slug}, ${label}, ${i})
      ON CONFLICT (slug) DO UPDATE SET label = ${label}, sort = ${i}`;
  }

  // Settings only fill missing keys so admin edits survive reseeding.
  for (const [key, value] of Object.entries(data.settings)) {
    await sql`INSERT INTO hq_settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT (key) DO NOTHING`;
  }

  const [{ count: milestoneCount }] = await sql`SELECT count(*)::int AS count FROM hq_milestones`;
  if (milestoneCount === 0) {
    for (const { date, label } of data.milestones) {
      await sql`INSERT INTO hq_milestones (date, label) VALUES (${date}, ${label})`;
    }
  }

  const [{ count: awardCount }] = await sql`SELECT count(*)::int AS count FROM hq_awards`;
  if (awardCount === 0) {
    for (const [i, { name, sponsor, amount }] of data.awards.entries()) {
      await sql`INSERT INTO hq_awards (name, sponsor, amount, sort)
        VALUES (${name}, ${sponsor}, ${amount}, ${i})`;
    }
  }

  const printed: Array<[string, string]> = [];
  for (const { username: rawUsername, displayName } of data.users) {
    const username = rawUsername.trim().toLowerCase();
    const existing = await sql`SELECT id FROM hq_users WHERE username = ${username}`;
    if (existing.length > 0 && !resetPasswords) continue;
    const password = tempPassword();
    const hash = await bcrypt.hash(password, 12);
    if (existing.length > 0) {
      await sql`UPDATE hq_users
        SET password_hash = ${hash},
            password_version = password_version + 1,
            must_change_password = true
        WHERE username = ${username}`;
    } else {
      await sql`INSERT INTO hq_users (username, display_name, password_hash)
        VALUES (${username}, ${displayName}, ${hash})`;
    }
    printed.push([displayName, password]);
  }

  console.log("Seed complete.");
  if (printed.length > 0) {
    console.log("\nTemporary passwords (shown once — hand these out, then they");
    console.log("must be changed on first login):\n");
    for (const [name, password] of printed) {
      console.log(`  ${name.padEnd(6)} ${password}`);
    }
  } else {
    console.log("Users already exist; passwords unchanged (use --reset-passwords to rotate).");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
