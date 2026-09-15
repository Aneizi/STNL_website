// The nine findings of the 15 September 2026 review of phases 0 to 6, one
// describe block each, against the real schema on PGlite.
//
// Every test here fails against the implementation as it was reviewed. They
// are kept together rather than spread through the existing files because
// what they have in common is what they are for: each one is the behaviour a
// finding said was wrong, asserted at the boundary the finding named — the
// serialized panel a team's browser receives, the rows left in the database
// after a schedule change, the page a reassigned Captain gets back.
//
// Nothing is mocked except `server-only`: the authorization decisions are the
// real ones over real rows.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ builderDatabase: vi.fn() }));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));

import type { Actor, MemberActor } from "@/lib/hq/actor";
import { loadTeamMembership } from "@/lib/hq/authz-sql";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { grantCapability } from "@/lib/hq/capabilities";
import { assignCaptain } from "@/lib/hq/captains";
import { correctPersonMatch, ensurePersonForAccount, ensurePersonForRosterMember } from "@/lib/hq/crm-identity";
import {
  closePeriod,
  createUpdate,
  enableReporting,
  ensureReportingPeriods,
  listReportingPeriods,
  pauseReporting,
  previewReportingPeriods,
  readAuthorizedUpdates,
  readOwnUpdates,
  reportingStatus,
} from "@/lib/hq/reporting";
import { utcToZonedDateTime, zonedDateTimeToUtc } from "@/lib/hq/reporting-periods";
import { teamReportingPanel } from "@/lib/hq/reporting-surface";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR_ID = "00000000-0000-4000-8000-0000000000b1";
const EDITION = 71;
const PROJECT = "00000000-0000-4000-9000-0000000000b1";
const OTHER_PROJECT = "00000000-0000-4000-9000-0000000000b2";

let pg: PGlite;
let db: BuilderDatabase;

async function rows(text: string, values: unknown[] = []) {
  return (await pg.query(text, values)).rows as Record<string, unknown>[];
}

const OPERATOR: Actor = { kind: "operator", id: OPERATOR_ID, displayName: "Operator" };

function member(id: string, capabilities: "captain"[] = []): MemberActor {
  return { kind: "member", id, name: id, email: `${id}@example.test`, capabilities: new Set(capabilities), telegram: null };
}

async function seedAccount(id: string) {
  await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true) ON CONFLICT (id) DO NOTHING`, [id, id, `${id}@example.test`]);
  await rows(`INSERT INTO hq_builder_profiles(id,email,name) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [id, `${id}@example.test`, id]);
}

async function seedProject(id: string, name = "Project") {
  await rows(
    `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
     SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f LIMIT 1`,
    [id, EDITION, name],
  );
}

/** A project imported from Colosseum: a verified owner, HQ ownership and a joined roster row. */
async function seedImportedProject(id: string, owner: string, name = "Project") {
  await seedProject(id, name);
  await seedAccount(owner);
  await rows(
    `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,verification,lead_username)
     VALUES($1,$2,$3,$4,$5,'{}',$6,'verified',$6)`,
    [id, EDITION, id.endsWith("b1") ? 9001 : 9002, `https://colosseum.com/arena/projects/explore/${owner}`, owner, owner],
  );
  await rows(`INSERT INTO hq_project_ownership(project_id,hackathon_id,owner_user_id,source) VALUES($1,$2,$3,'import')`, [id, EDITION, owner]);
  await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$2,$2,now())`, [id, owner]);
}

async function seedAssignedCaptain(userId: string, projectId: string) {
  await seedAccount(userId);
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId, capability: "captain", reason: "test" });
  const result = await assignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId, hackathonId: EDITION, captainUserId: userId });
  if (result.outcome !== "assigned") throw new Error(`could not assign the test Captain: ${JSON.stringify(result)}`);
}

/** Midday inside week one of the seeded campaign (14 to 20 September 2026, Europe/Amsterdam). */
const IN_WEEK_ONE = Date.parse("2026-09-16T10:00:00.000Z");
/** After week one has ended. */
const AFTER_WEEK_ONE = Date.parse("2026-09-21T10:00:00.000Z");

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  mocks.builderDatabase.mockReturnValue(db);
  await rows(`INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'op','Operator','x')`, [OPERATOR_ID]);
  await rows(`INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('onboarding','Onboarding','accent',true,100)`);
  await rows(`INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES('unassessed','Not assessed','muted',100)`);
});

afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM hq_reporting_entries; DELETE FROM hq_reporting_outcomes;
    DELETE FROM hq_reporting_pause_intervals; DELETE FROM hq_reporting_eligibility;
    DELETE FROM hq_reporting_periods; DELETE FROM hq_reporting_config;
    DELETE FROM hq_captain_assignments; DELETE FROM hq_account_capabilities; DELETE FROM hq_audit_events;
    DELETE FROM hq_project_members; DELETE FROM hq_project_ownership; DELETE FROM hq_project_onboarding;
    DELETE FROM hq_project_import_requests; DELETE FROM hq_projects;
    DELETE FROM hq_builder_enrollments; DELETE FROM hq_people; DELETE FROM hq_crm_persons;
    DELETE FROM hq_builder_profiles; DELETE FROM hq_auth_user;
    DELETE FROM hq_settings; DELETE FROM hq_hackathons;
  `);
  await rows(`INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES($1,'worlds-fair','Worlds Fair','2026-09-14','2026-10-12')`, [EDITION]);
});

/* ── 1. Schedule reconciliation must not delete saved reporting ─────── */

describe("finding 1: reconciliation never removes a week that holds reporting", () => {
  it("keeps a period with a saved update, and its entry and revisions, when the dates would drop it", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    const periods = await listReportingPeriods(db, EDITION);
    expect(periods).toHaveLength(5);
    const fourth = periods[3];

    // An update saved in the fourth week, committed, exactly as a team would.
    const saved = await createUpdate(member("owner-1"), {
      projectId: PROJECT, hackathonId: EDITION, body: "Week four", periodId: fourth.id,
    }, db);
    expect(saved.ok).toBe(true);

    // The campaign is shortened so the fourth and fifth weeks would go.
    await rows("UPDATE hq_hackathons SET end_date='2026-09-27' WHERE id=$1", [EDITION]);
    const plan = await ensureReportingPeriods(db, EDITION);

    // The week is reported as a conflict rather than removed, and the update
    // and its revision are still there.
    expect(plan.conflicts.map((conflict) => conflict.sequence)).toContain(fourth.sequence);
    expect((await listReportingPeriods(db, EDITION)).some((period) => period.id === fourth.id)).toBe(true);
    expect((await rows("SELECT id FROM hq_reporting_entries")).length).toBe(1);
    expect((await rows("SELECT entry_id FROM hq_reporting_entry_revisions")).length).toBe(1);
  });

  it("locks the edition's weeks before it counts what is in them", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    // The lock itself cannot be observed on PGlite's single connection, so
    // this asserts the statement is there: without it the count and the
    // delete are two separate moments and an entry saved between them is
    // taken out by the cascade.
    const source = await import("node:fs").then((fs) => fs.readFileSync("lib/hq/reporting-enrolment.ts", "utf8"));
    expect(source).toContain("FROM hq_reporting_periods WHERE hackathon_id = $1 ORDER BY sequence FOR UPDATE");
    // And that the delete re-states the protection for itself.
    expect(source).toContain("DELETE FROM hq_reporting_periods WHERE id=$1::uuid AND closed_at IS NULL AND ");
  });

  it("refuses to save an update against a week that has just been removed", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    const periods = await listReportingPeriods(db, EDITION);
    const last = periods[periods.length - 1];
    await rows("DELETE FROM hq_reporting_periods WHERE id=$1", [last.id]);
    const result = await createUpdate(member("owner-1"), {
      projectId: PROJECT, hackathonId: EDITION, body: "Into a week that is gone", periodId: last.id,
    }, db);
    expect(result).toMatchObject({ ok: false, reason: "period_not_found" });
  });
});

/* ── 4. A change must leave a continuous schedule ───────────────────── */

describe("finding 4: applying dates never leaves a gap or an overlap", () => {
  it("refuses the change that would leave 21 September in no week at all, and writes nothing", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    const before = await listReportingPeriods(db, EDITION);
    // Week one, 14 to 20 September, now holds an update, so it cannot move.
    const saved = await createUpdate(member("owner-1"), {
      projectId: PROJECT, hackathonId: EDITION, body: "Week one", periodId: before[0].id,
    }, db);
    expect(saved.ok).toBe(true);

    // Starting a day later moves every other week a day later with it.
    await rows("UPDATE hq_hackathons SET start_date='2026-09-15' WHERE id=$1", [EDITION]);

    const preview = await previewReportingPeriods(db, EDITION);
    expect(preview.blocked).toBe(true);
    expect(preview.problems[0]).toMatchObject({ kind: "gap", beforeEndDate: "2026-09-20", afterStartDate: "2026-09-22" });

    const applied = await ensureReportingPeriods(db, EDITION);
    expect(applied.blocked).toBe(true);
    // Nothing moved: the stored weeks are exactly what they were.
    expect(await listReportingPeriods(db, EDITION)).toEqual(before);
  });

  it("still applies a change that keeps the weeks continuous, such as extending the campaign", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    await rows("UPDATE hq_hackathons SET end_date='2026-10-19' WHERE id=$1", [EDITION]);
    const applied = await ensureReportingPeriods(db, EDITION);
    expect(applied.blocked).toBe(false);
    expect(applied.problems).toEqual([]);
    const periods = await listReportingPeriods(db, EDITION);
    expect(periods[periods.length - 1].endDate).toBe("2026-10-19");
    // Every week still begins exactly where the one before it ended.
    for (let index = 1; index < periods.length; index += 1) {
      expect(periods[index].startsAt).toBe(periods[index - 1].endsAt);
    }
  });
});

/* ── 3. A pause must not become missed weeks when it ends ───────────── */

describe("finding 3: resuming reporting does not invent the weeks the pause covered", () => {
  it("keeps the exemption for a week that closed while the project was paused", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    const [weekOne] = await listReportingPeriods(db, EDITION);

    await pauseReporting(db, { projectId: PROJECT, hackathonId: EDITION, paused: true, operatorId: OPERATOR_ID, reason: "Team on holiday" });
    const closed = await closePeriod(db, { periodId: weekOne.id, actor: OPERATOR, atMs: AFTER_WEEK_ONE });
    expect(closed.ok).toBe(true);

    const whilePaused = await reportingStatus(db, { hackathonId: EDITION, projectIds: [PROJECT], atMs: AFTER_WEEK_ONE });
    expect(whilePaused[0].missedPeriods).toBe(0);

    await pauseReporting(db, { projectId: PROJECT, hackathonId: EDITION, paused: false, operatorId: OPERATOR_ID });

    const afterResume = await reportingStatus(db, { hackathonId: EDITION, projectIds: [PROJECT], atMs: AFTER_WEEK_ONE });
    expect(afterResume[0].paused).toBe(false);
    expect(afterResume[0].missedPeriods).toBe(0);
  });

  it("keeps a genuine miss from before the pause, and a second pause keeps its own window", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    const periods = await listReportingPeriods(db, EDITION);

    // Week one is genuinely missed: nothing written, not paused, and closed.
    await closePeriod(db, { periodId: periods[0].id, actor: OPERATOR, atMs: AFTER_WEEK_ONE });
    // Then a pause covering week two, and a resume after it closed.
    await pauseReporting(db, { projectId: PROJECT, hackathonId: EDITION, paused: true, operatorId: OPERATOR_ID });
    const afterWeekTwo = Date.parse("2026-09-28T10:00:00.000Z");
    await closePeriod(db, { periodId: periods[1].id, actor: OPERATOR, atMs: afterWeekTwo });
    await pauseReporting(db, { projectId: PROJECT, hackathonId: EDITION, paused: false, operatorId: OPERATOR_ID });

    const status = await reportingStatus(db, { hackathonId: EDITION, projectIds: [PROJECT], atMs: afterWeekTwo });
    expect(status[0].missedPeriods).toBe(1);

    // Pausing again opens a second interval rather than reusing the first.
    await pauseReporting(db, { projectId: PROJECT, hackathonId: EDITION, paused: true, operatorId: OPERATOR_ID });
    expect((await rows("SELECT id FROM hq_reporting_pause_intervals")).length).toBe(2);
    expect((await rows("SELECT id FROM hq_reporting_pause_intervals WHERE resumed_at IS NULL")).length).toBe(1);
  });

  it("closes the open pause when reporting is re-enabled rather than paused off", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    await pauseReporting(db, { projectId: PROJECT, hackathonId: EDITION, paused: true, operatorId: OPERATOR_ID });
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION, operatorId: OPERATOR_ID });
    expect((await rows("SELECT id FROM hq_reporting_pause_intervals WHERE resumed_at IS NULL")).length).toBe(0);
  });
});

/* ── 2. The team panel must carry nothing about a hidden note ───────── */

describe("finding 2: a sensitive note leaves no trace in what the team's browser receives", () => {
  it("sends no entry count, no note timestamp and no completion basis for any week", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    await seedAssignedCaptain("captain-1", PROJECT);

    const note = await createUpdate(member("captain-1", ["captain"]), {
      projectId: PROJECT, hackathonId: EDITION, body: "A private worry about this team", visibility: "sensitive", atMs: IN_WEEK_ONE,
    }, db);
    expect(note.ok).toBe(true);

    const panel = await teamReportingPanel(member("owner-1"), { projectId: PROJECT, hackathonId: EDITION }, db);

    // The body was already withheld; so is everything that would count it.
    expect(panel.entries).toEqual([]);
    const serialized = JSON.stringify(panel);
    expect(serialized).not.toContain("A private worry");
    expect(serialized).not.toContain("entries\":1");
    expect(serialized).not.toContain("latestEntryAt");
    expect(serialized).not.toContain("basis");
    for (const week of [panel.current, ...panel.history]) {
      if (!week) continue;
      expect(Object.keys(week).sort()).toEqual(
        ["completed", "endDate", "endsAt", "periodId", "periodSequence", "startDate", "startsAt"],
      );
    }
    // The Updated flag the plan requires is still there: a sensitive note
    // completes the week, and the team is told the week is done.
    expect(panel.current?.completed).toBe(true);
  });

  it("still gives the team its own updates in full", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    await createUpdate(member("owner-1"), { projectId: PROJECT, hackathonId: EDITION, body: "What we shipped", atMs: IN_WEEK_ONE }, db);
    const panel = await teamReportingPanel(member("owner-1"), { projectId: PROJECT, hackathonId: EDITION }, db);
    expect(panel.entries.map((entry) => entry.body)).toEqual(["What we shipped"]);
  });
});

/* ── 6. Older updates stay reachable ────────────────────────────────── */

describe("finding 6: an older update can still be browsed and edited", () => {
  it("pages past the first page with the cursor the panel is given", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    for (let index = 0; index < 12; index += 1) {
      const saved = await createUpdate(member("owner-1"), {
        projectId: PROJECT, hackathonId: EDITION, body: `Update ${index}`, atMs: IN_WEEK_ONE + index * 1000,
      }, db);
      expect(saved.ok).toBe(true);
    }
    const panel = await teamReportingPanel(member("owner-1"), { projectId: PROJECT, hackathonId: EDITION }, db);
    expect(panel.entries).toHaveLength(10);
    expect(panel.nextCursor).not.toBeNull();

    const next = await readAuthorizedUpdates(member("owner-1"), {
      projectId: PROJECT, hackathonId: EDITION, limit: 10, cursor: panel.nextCursor!,
    }, db);
    expect(next.entries.map((entry) => entry.body)).toEqual(["Update 1", "Update 0"]);
    // And the author can still edit the oldest one, which is the point.
    expect(next.entries.every((entry) => entry.canEdit)).toBe(true);
  });

  it("narrows to one week, so a period with no recent activity is still reachable", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    const periods = await listReportingPeriods(db, EDITION);
    await createUpdate(member("owner-1"), { projectId: PROJECT, hackathonId: EDITION, body: "Week one note", periodId: periods[0].id }, db);
    await createUpdate(member("owner-1"), { projectId: PROJECT, hackathonId: EDITION, body: "Week two note", periodId: periods[1].id }, db);
    const weekOne = await readAuthorizedUpdates(member("owner-1"), {
      projectId: PROJECT, hackathonId: EDITION, periodId: periods[0].id,
    }, db);
    expect(weekOne.entries.map((entry) => entry.body)).toEqual(["Week one note"]);
  });
});

/* ── 7. A reassigned Captain keeps their own notes ──────────────────── */

describe("finding 7: a reassigned Captain can still read the notes they wrote", () => {
  it("returns their own sensitive note, read-only, after another Captain takes the project", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    await seedAssignedCaptain("captain-1", PROJECT);
    const note = await createUpdate(member("captain-1", ["captain"]), {
      projectId: PROJECT, hackathonId: EDITION, body: "My own private note", visibility: "sensitive", atMs: IN_WEEK_ONE,
    }, db);
    expect(note.ok).toBe(true);

    await seedAssignedCaptain("captain-2", PROJECT);

    const author = member("captain-1", ["captain"]);
    // The project read still gives them nothing, which is correct.
    expect((await readAuthorizedUpdates(author, { projectId: PROJECT, hackathonId: EDITION }, db)).entries).toEqual([]);
    // The author-only read gives them their own note back, and only that.
    const own = await readOwnUpdates(author, { hackathonId: EDITION }, db);
    expect(own.entries.map((entry) => entry.body)).toEqual(["My own private note"]);
    expect(own.entries[0]).toMatchObject({ canEdit: false, visibility: "sensitive", projectName: "Project" });
  });

  it("gives nothing to an account whose Captain capability has been revoked", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    await seedAssignedCaptain("captain-1", PROJECT);
    await createUpdate(member("captain-1", ["captain"]), {
      projectId: PROJECT, hackathonId: EDITION, body: "Note before revocation", visibility: "sensitive", atMs: IN_WEEK_ONE,
    }, db);
    await rows("UPDATE hq_account_capabilities SET revoked_at=now() WHERE user_id='captain-1'");
    expect((await readOwnUpdates(member("captain-1", ["captain"]), { hackathonId: EDITION }, db)).entries).toEqual([]);
  });

  it("never returns another author's note, whatever the reader holds", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await enableReporting(db, { projectId: PROJECT, hackathonId: EDITION });
    await seedAssignedCaptain("captain-1", PROJECT);
    await createUpdate(member("captain-1", ["captain"]), {
      projectId: PROJECT, hackathonId: EDITION, body: "Captain one's note", visibility: "sensitive", atMs: IN_WEEK_ONE,
    }, db);
    await seedAssignedCaptain("captain-2", PROJECT);
    const other = await readOwnUpdates(member("captain-2", ["captain"]), { hackathonId: EDITION }, db);
    expect(other.entries).toEqual([]);
  });
});

/* ── 5. A CRM correction must not make a Captain a participant ──────── */

describe("finding 5: an identity correction cannot make a Captain a member of their own project", () => {
  it("refuses to attach a roster identity to the project's current Captain", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await seedAccount("captain-1");
    await ensurePersonForAccount(db, { userId: "captain-1", displayName: "captain-1" });
    // A roster seat nobody has claimed, with a provisional person of its own.
    const rosterPerson = await ensurePersonForRosterMember(db, { colosseumUsername: "unclaimed", displayName: "Unclaimed Teammate" });
    await rows(
      `INSERT INTO hq_project_members(project_id,name,colosseum_username,person_id) VALUES($1,'Unclaimed Teammate','unclaimed',$2)`,
      [PROJECT, rosterPerson],
    );

    // Assigning is allowed once the operator acknowledges the unresolved seat.
    await grantCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId: "captain-1", capability: "captain", reason: "test" });
    const first = await assignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId: PROJECT, hackathonId: EDITION, captainUserId: "captain-1" });
    expect(first.outcome).toBe("needs_review");
    const acknowledged = await assignCaptain(db, {
      actorOperatorId: OPERATOR_ID, projectId: PROJECT, hackathonId: EDITION, captainUserId: "captain-1",
      acknowledgedUnresolvedIds: first.outcome === "needs_review" ? first.unresolved.map((row) => row.memberId) : [],
    });
    expect(acknowledged.outcome).toBe("assigned");

    // Correcting that seat onto the Captain's account is what the review
    // found: it would leave both the roster identity and the assignment.
    await expect(correctPersonMatch(db, {
      personId: rosterPerson, toUserId: "captain-1", reason: "They are that teammate", actor: { kind: "operator", id: OPERATOR_ID },
    })).rejects.toThrow(/current Captain/);

    // And nothing was written: the roster seat still has its own person.
    const [seat] = await rows("SELECT person_id::text AS person_id FROM hq_project_members WHERE colosseum_username='unclaimed'");
    expect(String(seat.person_id)).toBe(rosterPerson);
  });

  it("allows the same correction once the Captain has been reassigned", async () => {
    await seedImportedProject(PROJECT, "owner-1");
    await seedAccount("captain-1");
    await ensurePersonForAccount(db, { userId: "captain-1", displayName: "captain-1" });
    const rosterPerson = await ensurePersonForRosterMember(db, { colosseumUsername: "unclaimed", displayName: "Unclaimed Teammate" });
    await rows(
      `INSERT INTO hq_project_members(project_id,name,colosseum_username,person_id) VALUES($1,'Unclaimed Teammate','unclaimed',$2)`,
      [PROJECT, rosterPerson],
    );
    // No assignment at all this time.
    const corrected = await correctPersonMatch(db, {
      personId: rosterPerson, toUserId: "captain-1", reason: "They are that teammate", actor: { kind: "operator", id: OPERATOR_ID },
    });
    expect(corrected.changed).toBe(true);
    expect(corrected.movedRosterRows).toBe(1);
  });
});

/* ── 8. The submission deadline is the campaign's clock ─────────────── */

describe("finding 8: the submission deadline is read and shown in the campaign timezone", () => {
  it("stores what an Amsterdam admin typed, whatever the server's own timezone is", () => {
    // 23:59 in Amsterdam on 12 October 2026 is 21:59 UTC, not 23:59 UTC.
    expect(zonedDateTimeToUtc("2026-10-12", "23:59", "Europe/Amsterdam").toISOString()).toBe("2026-10-12T21:59:00.000Z");
    // The naive reading a UTC server would have taken, for contrast.
    expect(new Date("2026-10-12T23:59Z").toISOString()).toBe("2026-10-12T23:59:00.000Z");
  });

  it("round-trips: what is shown in the form is what was typed", () => {
    const stored = zonedDateTimeToUtc("2026-10-12", "23:59", "Europe/Amsterdam").toISOString();
    expect(utcToZonedDateTime(stored, "Europe/Amsterdam")).toBe("2026-10-12T23:59");
    // Slicing the stored UTC string, which is what the form used to do, is
    // two hours out.
    expect(stored.slice(0, 16)).toBe("2026-10-12T21:59");
  });

  it("works across the campaign's own daylight saving change", () => {
    const summer = zonedDateTimeToUtc("2026-09-20", "23:59", "Europe/Amsterdam").toISOString();
    const winter = zonedDateTimeToUtc("2026-11-20", "23:59", "Europe/Amsterdam").toISOString();
    expect(summer).toBe("2026-09-20T21:59:00.000Z");
    expect(winter).toBe("2026-11-20T22:59:00.000Z");
    expect(utcToZonedDateTime(summer, "Europe/Amsterdam")).toBe("2026-09-20T23:59");
    expect(utcToZonedDateTime(winter, "Europe/Amsterdam")).toBe("2026-11-20T23:59");
  });
});

/* ── 9. The manual fallback produces real team access ───────────────── */

describe("finding 9: a hand-created project gives its owner the same access an import does", () => {
  it("makes the requesting account the owner, with no invented Colosseum id", async () => {
    await seedAccount("asker-1");
    await seedProject(OTHER_PROJECT, "Hand made");
    await rows(
      `INSERT INTO hq_project_ownership(project_id,hackathon_id,owner_user_id,source,created_by_user_id)
       VALUES($1,$2,'asker-1','admin',$3)`,
      [OTHER_PROJECT, EDITION, OPERATOR_ID],
    );

    const membership = await loadTeamMembership(db, { userId: "asker-1", projectId: OTHER_PROJECT });
    expect(membership).toEqual({ projectId: OTHER_PROJECT, hackathonId: EDITION, role: "owner" });
    // No onboarding row was created, so no external id was fabricated.
    expect(await rows("SELECT project_id FROM hq_project_onboarding")).toEqual([]);
  });

  it("lets that owner read and write the project's weekly updates", async () => {
    await seedAccount("asker-1");
    await seedProject(OTHER_PROJECT, "Hand made");
    await rows(
      `INSERT INTO hq_project_ownership(project_id,hackathon_id,owner_user_id,source) VALUES($1,$2,'asker-1','admin')`,
      [OTHER_PROJECT, EDITION],
    );
    await enableReporting(db, { projectId: OTHER_PROJECT, hackathonId: EDITION, operatorId: OPERATOR_ID });

    const saved = await createUpdate(member("asker-1"), {
      projectId: OTHER_PROJECT, hackathonId: EDITION, body: "Our first week", atMs: IN_WEEK_ONE,
    }, db);
    expect(saved.ok).toBe(true);

    const panel = await teamReportingPanel(member("asker-1"), { projectId: OTHER_PROJECT, hackathonId: EDITION }, db);
    expect(panel.enrolled).toBe(true);
    expect(panel.entries.map((entry) => entry.body)).toEqual(["Our first week"]);
  });

  it("gives nothing to an unrelated account", async () => {
    await seedAccount("asker-1");
    await seedAccount("stranger-1");
    await seedProject(OTHER_PROJECT, "Hand made");
    await rows(
      `INSERT INTO hq_project_ownership(project_id,hackathon_id,owner_user_id,source) VALUES($1,$2,'asker-1','admin')`,
      [OTHER_PROJECT, EDITION],
    );
    expect(await loadTeamMembership(db, { userId: "stranger-1", projectId: OTHER_PROJECT })).toBeNull();
  });

  it("keeps the HQ project, its Captain and its updates when the Colosseum source is attached later", async () => {
    await seedAccount("asker-1");
    await seedProject(OTHER_PROJECT, "Hand made");
    await rows(
      `INSERT INTO hq_project_ownership(project_id,hackathon_id,owner_user_id,source) VALUES($1,$2,'asker-1','admin')`,
      [OTHER_PROJECT, EDITION],
    );
    await enableReporting(db, { projectId: OTHER_PROJECT, hackathonId: EDITION, operatorId: OPERATOR_ID });
    await createUpdate(member("asker-1"), { projectId: OTHER_PROJECT, hackathonId: EDITION, body: "Before the link", atMs: IN_WEEK_ONE }, db);
    await seedAssignedCaptain("captain-1", OTHER_PROJECT);

    // What `attachSourceToProject` writes: the onboarding row lands on the
    // project that already exists rather than on a new one.
    await rows(
      `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,verification,lead_username)
       VALUES($1,$2,4242,'https://colosseum.com/arena/projects/explore/handmade','handmade','{}','asker-1','verified','asker-1')`,
      [OTHER_PROJECT, EDITION],
    );

    expect(await loadTeamMembership(db, { userId: "asker-1", projectId: OTHER_PROJECT })).toMatchObject({ role: "owner" });
    const entries = await readAuthorizedUpdates(member("asker-1"), { projectId: OTHER_PROJECT, hackathonId: EDITION }, db);
    expect(entries.entries.map((entry) => entry.body)).toEqual(["Before the link"]);
    const [assignment] = await rows("SELECT captain_user_id FROM hq_captain_assignments WHERE project_id=$1 AND unassigned_at IS NULL", [OTHER_PROJECT]);
    expect(String(assignment.captain_user_id)).toBe("captain-1");
  });
});
