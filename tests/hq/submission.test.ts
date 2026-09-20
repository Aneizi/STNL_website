// Phase 10, the final submission-focused period, against the real schema on
// PGlite with a stubbed Colosseum transport.
//
// What each block is proving, in the plan's own words:
//
// - "The final dashboard begins 5 October and includes 12 October without
//   creating a fifth week."
// - "A confirmed submission satisfies the final week and cancels a queued
//   missing-update reminder."
// - "An incomplete draft, missing source data and complete materials without
//   actual submission do not show Submitted."
// - "External outages and delayed evidence do not manufacture false
//   historical conclusions", and "a submission made after the deadline
//   remains late and does not erase an on-time failure".
// - "Use bounded server-side refreshes during the final period if configured;
//   do not poll Colosseum from every browser tab."
//
// Nothing here mocks the reporting service, the authorization decisions or
// the submission interpretation: the only stub is the HTTP transport, so a
// green assertion below is an assertion about what production would record.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ builderDatabase: vi.fn() }));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));

import type { ColosseumFetch } from "@/lib/colosseum-api";
import type { Actor } from "@/lib/hq/actor";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { grantCapability } from "@/lib/hq/capabilities";
import { assignCaptain } from "@/lib/hq/captains";
import { closeDuePeriods } from "@/lib/hq/jobs";
import { outstandingForCaptain } from "@/lib/hq/reminder-dispatch";
import {
  closePeriod,
  createUpdate,
  enableReporting,
  ensureReportingPeriods,
  listPeriodOutcomes,
  listReportingPeriods,
  reportingStatus,
  writeReportingConfig,
} from "@/lib/hq/reporting";
import {
  dueSubmissionRefreshes,
  readSubmissionReconciliations,
  openSubmissionReconciliations,
  readSubmissionSnapshots,
  reconcileSubmissions,
  refreshDueSubmissions,
} from "@/lib/hq/submission";
import { captainReportingBoard, memberWeekSummaries, teamReportingPanel } from "@/lib/hq/reporting-surface";
import { projectNeedsAttention } from "@/lib/hq/dashboard-attention";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR_ID = "00000000-0000-4000-8000-0000000000b1";
const EDITION = 71;
const PROJECT_A = "00000000-0000-4000-9100-000000000001";
const PROJECT_B = "00000000-0000-4000-9100-000000000002";
/** An admin-created project with no Colosseum source at all. */
const BARE_PROJECT = "00000000-0000-4000-9100-000000000003";

/** Inside the final period, 5 to 12 October 2026, Europe/Amsterdam. */
const IN_FINAL = Date.parse("2026-10-07T09:00:00Z");
/** After it: local midnight ending 12 October is 2026-10-12T22:00Z. */
const AFTER_FINAL = Date.parse("2026-10-13T06:00:00Z");

let pg: PGlite;
let db: BuilderDatabase;

async function rows(text: string, values: unknown[] = []) {
  return (await pg.query(text, values)).rows as Record<string, unknown>[];
}

const OPERATOR: Actor = { kind: "operator", id: OPERATOR_ID, displayName: "Operator" };
const member = (id: string, capabilities: "captain"[] = []): Actor =>
  ({ kind: "member", id, name: id, email: `${id}@example.test`, capabilities: new Set(capabilities), telegram: null });

async function seedAccount(id: string) {
  await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true) ON CONFLICT (id) DO NOTHING`, [id, id, `${id}@example.test`]);
  await rows(`INSERT INTO hq_builder_profiles(id,email,name) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [id, `${id}@example.test`, id]);
}

async function seedProject(id: string, name: string) {
  await rows(
    `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
     SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f LIMIT 1`,
    [id, EDITION, name],
  );
}

let externalId = 5000;
const sourceIds = new Map<string, number>();

/** A project with an imported Colosseum team over it, whose slug is its own owner handle. */
async function seedImported(id: string, owner: string, name = "Project") {
  await seedProject(id, name);
  await seedAccount(owner);
  externalId += 1;
  sourceIds.set(owner, externalId);
  await rows(
    `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,external_hackathon_id,project_url,slug,raw,owner_user_id,verification,lead_username)
     VALUES($1,$2,$3,4242,$4,$5,'{}',$6,'verified',$6)`,
    [id, EDITION, externalId, `https://colosseum.com/arena/projects/explore/${owner}`, owner, owner],
  );
  await rows(`INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$2,$2,now())`, [id, owner]);
}

async function seedAssignedCaptain(userId: string, projectId: string) {
  await seedAccount(userId);
  await grantCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId, capability: "captain", reason: "test" });
  const result = await assignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId, hackathonId: EDITION, captainUserId: userId });
  if (result.outcome !== "assigned") throw new Error(`could not assign the test Captain: ${JSON.stringify(result)}`);
}

/**
 * A Colosseum detail response for one slug, as `GET /api/project` returns it.
 * `submittedAt` is the whole point: null is a draft, a timestamp is a
 * submission, and `interpretSubmission` is the one thing that reads it.
 */
function detailBody(slug: string, options: { submittedAt?: string | null; links?: Record<string, string> } = {}) {
  return {
    projectType: "HACKATHON",
    project: {
      id: sourceIds.get(slug),
      // An invented edition. The real external mapping is operator data in
      // `hq_hackathon_onboarding` and belongs in no file here. A refresh
      // verifies it against the imported snapshot's stored edition.
      hackathonId: 4242,
      slug,
      name: `Project ${slug}`,
      description: "A fictional project used only in tests.",
      country: "Netherlands",
      submittedAt: options.submittedAt ?? null,
      hackathon: { id: 4242, slug: "fictional-edition", name: "Fictional Edition" },
      teamMembers: [{ username: slug, displayName: slug, avatarUrl: null }],
      ...(options.links ?? {}),
    },
  };
}

/** A transport that answers every detail request from `bodies`, and counts what it was asked. */
function stubFetch(bodies: Record<string, unknown>): ColosseumFetch & { calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const slug = url.searchParams.get("slug") ?? "";
    calls.push(slug);
    const body = bodies[slug];
    if (body === undefined) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as ColosseumFetch & { calls: string[] };
  fetcher.calls = calls;
  return fetcher;
}

/** A transport that is down: every request times out, which is the outage the plan names. */
const brokenFetch: ColosseumFetch = async () => {
  throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
};

const finalPeriod = async () => (await listReportingPeriods(db, EDITION)).find((period) => period.mode === "submission")!;

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
    DELETE FROM hq_submission_reconciliations; DELETE FROM hq_reminder_deliveries;
    DELETE FROM hq_reporting_entry_revisions; DELETE FROM hq_reporting_entries;
    DELETE FROM hq_reporting_outcomes; DELETE FROM hq_reporting_pause_intervals;
    DELETE FROM hq_reporting_eligibility; DELETE FROM hq_reporting_periods; DELETE FROM hq_reporting_config;
    DELETE FROM hq_captain_assignments; DELETE FROM hq_account_capabilities; DELETE FROM hq_audit_events;
    DELETE FROM hq_project_members; DELETE FROM hq_project_onboarding; DELETE FROM hq_projects;
    DELETE FROM hq_builder_enrollments; DELETE FROM hq_people; DELETE FROM hq_crm_persons;
    DELETE FROM hq_builder_profiles; DELETE FROM hq_auth_user;
    DELETE FROM hq_settings; DELETE FROM hq_hackathons;
  `);
  await rows(`INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES($1,'worlds-fair','Worlds Fair','2026-09-14','2026-10-12')`, [EDITION]);
  await rows(`INSERT INTO hq_reporting_config(hackathon_id,final_period_start_date) VALUES($1,'2026-10-05')`, [EDITION]);
  await seedImported(PROJECT_A, "alice", "Alpha");
  await seedImported(PROJECT_B, "bob", "Beta");
  await enableReporting(db, { projectId: PROJECT_A, hackathonId: EDITION });
  await enableReporting(db, { projectId: PROJECT_B, hackathonId: EDITION });
  await ensureReportingPeriods(db, EDITION);
});

describe("the final period's own boundaries", () => {
  it("begins 5 October and includes 12 October, and adds no fifth week after it", async () => {
    const periods = await listReportingPeriods(db, EDITION);
    expect(periods.map((period) => [period.sequence, period.mode, period.startDate, period.endDate])).toEqual([
      [1, "weekly", "2026-09-14", "2026-09-20"],
      [2, "weekly", "2026-09-21", "2026-09-27"],
      [3, "weekly", "2026-09-28", "2026-10-04"],
      [4, "submission", "2026-10-05", "2026-10-12"],
    ]);
    // The exclusive end is local midnight after the campaign's last day, so
    // 12 October is inside the final period rather than the first day of a
    // fifth one.
    expect(periods[3].endsAt).toBe("2026-10-12T22:00:00.000Z");
  });

  it("is the open period on its first and on its last day, and no period at all after it", async () => {
    const at = async (iso: string) =>
      (await reportingStatus(db, { hackathonId: EDITION, projectIds: [PROJECT_A], atMs: Date.parse(iso) }))[0].current;
    expect(await at("2026-10-05T07:00:00Z")).toMatchObject({ periodSequence: 4, mode: "submission" });
    expect(await at("2026-10-12T21:00:00Z")).toMatchObject({ periodSequence: 4, mode: "submission" });
    // 2026-10-04T21:00Z is 23:00 on 4 October in Amsterdam: still week three.
    expect(await at("2026-10-04T21:00:00Z")).toMatchObject({ periodSequence: 3, mode: "weekly" });
    expect(await at("2026-10-13T06:00:00Z")).toBeNull();
  });
});

describe("what does and does not complete the final period", () => {
  const statusOf = async (projectId: string, atMs = IN_FINAL) =>
    (await reportingStatus(db, { hackathonId: EDITION, projectIds: [projectId], atMs, includeHistory: true }))[0];

  it("is satisfied by a confirmed, on-time submission with no written update at all", async () => {
    await rows(`UPDATE hq_project_onboarding SET submission_status='submitted',submitted_at='2026-10-06T10:00:00Z' WHERE project_id=$1`, [PROJECT_A]);
    expect((await statusOf(PROJECT_A)).current).toMatchObject({ mode: "submission", completed: true, basis: "submission", entries: 0 });
  });

  it("is satisfied by a written update on its own, and the submission stays visible either way", async () => {
    await createUpdate(member("alice"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Deck is done", atMs: IN_FINAL });
    const status = await statusOf(PROJECT_A);
    expect(status.current).toMatchObject({ completed: true, basis: "entry" });
    // The plan: "Submission status remains visible independently even if a
    // written update already completed the week."
    expect(status.submissionStatus).toBe("not_checked");
  });

  it("does not show Submitted for a draft, for a project never checked, or for complete materials with no submission", async () => {
    // A draft: Colosseum answers with the field present and null.
    const fetcher = stubFetch({
      alice: detailBody("alice", {
        submittedAt: null,
        links: { presentationLink: "https://example.test/deck", pitchVideoLink: "https://example.test/pitch", repoLink: "https://example.test/code" },
      }),
    });
    await rows(`UPDATE hq_reporting_config SET submission_refresh_minutes=15 WHERE hackathon_id=$1`, [EDITION]);
    await refreshDueSubmissions(db, { atMs: IN_FINAL, hackathonId: EDITION, fetcher });

    const snapshot = (await readSubmissionSnapshots(db, [PROJECT_A])).get(PROJECT_A)!;
    expect(snapshot.submissionStatus).toBe("not_submitted");
    expect(snapshot.links.presentation).toBe("https://example.test/deck");
    // Every material it has, and still not submitted: readiness is not
    // submission.
    expect((await statusOf(PROJECT_A)).current).toMatchObject({ completed: false, basis: "none" });
    // A project nothing has been read for stays neutral rather than red.
    expect((await statusOf(PROJECT_B)).submissionStatus).toBe("not_checked");
  });

  it("does not let a submission after the official deadline complete the period", async () => {
    await writeReportingConfig(db, {
      hackathonId: EDITION, finalPeriodStartDate: "2026-10-05",
      officialSubmissionDeadline: "2026-10-10T20:00:00.000Z", nudgeWeekday: 3, nudgeTime: "12:00",
    });
    await rows(`UPDATE hq_project_onboarding SET submission_status='submitted',submitted_at='2026-10-11T10:00:00Z' WHERE project_id=$1`, [PROJECT_A]);
    expect((await statusOf(PROJECT_A, Date.parse("2026-10-12T09:00:00Z"))).current)
      .toMatchObject({ completed: false, basis: "none" });
  });

  it("does not let a submission complete any earlier, weekly period", async () => {
    await rows(`UPDATE hq_project_onboarding SET submission_status='submitted',submitted_at='2026-09-20T10:00:00Z' WHERE project_id=$1`, [PROJECT_A]);
    const status = await statusOf(PROJECT_A);
    expect(status.history.slice(0, 3).map((period) => period.completed)).toEqual([false, false, false]);
    expect(status.current).toMatchObject({ completed: true, basis: "submission" });
  });
});

describe("the Wednesday reminder in the final period", () => {
  beforeEach(async () => {
    await seedAssignedCaptain("cap", PROJECT_A);
    await seedAssignedCaptain("cap", PROJECT_B);
  });

  it("names a team that has neither submitted nor written anything", async () => {
    const period = await finalPeriod();
    const outstanding = await outstandingForCaptain(db, { captainUserId: "cap", hackathonId: EDITION, periodId: period.id, atMs: IN_FINAL });
    expect(outstanding).toMatchObject({ ok: true, projectNames: ["Alpha", "Beta"] });
  });

  it("drops a team whose submission is confirmed, and cancels the message when every team has", async () => {
    const period = await finalPeriod();
    await rows(`UPDATE hq_project_onboarding SET submission_status='submitted',submitted_at='2026-10-06T10:00:00Z' WHERE project_id=$1`, [PROJECT_A]);
    expect(await outstandingForCaptain(db, { captainUserId: "cap", hackathonId: EDITION, periodId: period.id, atMs: IN_FINAL }))
      .toMatchObject({ ok: true, projectNames: ["Beta"] });

    await rows(`UPDATE hq_project_onboarding SET submission_status='submitted',submitted_at='2026-10-06T11:00:00Z' WHERE project_id=$1`, [PROJECT_B]);
    expect(await outstandingForCaptain(db, { captainUserId: "cap", hackathonId: EDITION, periodId: period.id, atMs: IN_FINAL }))
      .toEqual({ ok: false, reason: "nothing_outstanding" });
  });

  it("stops entirely once the final period has ended", async () => {
    const period = await finalPeriod();
    expect(await outstandingForCaptain(db, { captainUserId: "cap", hackathonId: EDITION, periodId: period.id, atMs: AFTER_FINAL }))
      .toEqual({ ok: false, reason: "period_over" });
  });
});

describe("what an authorized member is shown in the final period", () => {
  const alice = () => member("alice") as Extract<Actor, { kind: "member" }>;

  it("keeps Home attention on a submission after the written update is complete", async () => {
    await seedProject(BARE_PROJECT, "Manual project");
    await enableReporting(db, { projectId: BARE_PROJECT, hackathonId: EDITION });
    await createUpdate(alice(), { projectId: PROJECT_A, hackathonId: EDITION, body: "Ready for review.", atMs: IN_FINAL });
    const projects = [
      { id: PROJECT_A, name: "Alpha", hackathonId: EDITION },
      { id: BARE_PROJECT, name: "Manual project", hackathonId: EDITION },
    ];
    const [unknown, manual] = await memberWeekSummaries(projects, db, IN_FINAL);
    expect(unknown.current).toMatchObject({ completed: true });
    expect(unknown.submission).toMatchObject({ open: true, submissionStatus: "not_checked", periodId: unknown.current!.periodId });
    expect(Object.keys(unknown.submission!).sort()).toEqual(["deadline", "open", "periodId", "submissionStatus"]);
    expect(JSON.stringify(unknown)).not.toMatch(/Ready for review|"basis"|"entries"|"history"/);
    expect(projectNeedsAttention(unknown, IN_FINAL)).toBe(true);
    expect(manual.submission).toBeNull();

    await rows(`UPDATE hq_project_onboarding SET submission_status='submitted',submitted_at='2026-10-06T10:00:00Z' WHERE project_id=$1`, [PROJECT_A]);
    const [submitted] = await memberWeekSummaries(projects, db, IN_FINAL);
    expect(submitted.submission).toMatchObject({ open: true, submissionStatus: "submitted" });
    expect(projectNeedsAttention(submitted, IN_FINAL)).toBe(false);
  });

  it("does not keep Home attention on missed periods once the final period has closed", async () => {
    const [summary] = await memberWeekSummaries([{ id: PROJECT_A, name: "Alpha", hackathonId: EDITION }], db, AFTER_FINAL);
    expect(summary.current).toBeNull();
    expect(summary.missedPeriods).toBeGreaterThan(0);
    expect(summary.submission).toMatchObject({ open: false, submissionStatus: "not_checked" });
    expect(projectNeedsAttention(summary, AFTER_FINAL)).toBe(false);
  });

  it("carries the final period, its deadline and its checklist, with the requirements the admin recorded", async () => {
    await writeReportingConfig(db, {
      hackathonId: EDITION, finalPeriodStartDate: "2026-10-05",
      officialSubmissionDeadline: "2026-10-12T21:59:00.000Z", nudgeWeekday: 3, nudgeTime: "12:00",
      requiredMaterials: ["presentation", "pitchVideo"], optionalMaterials: ["repo"],
    });
    await rows(`UPDATE hq_project_onboarding SET presentation_link='https://example.test/deck' WHERE project_id=$1`, [PROJECT_A]);

    const panel = await teamReportingPanel(alice(), { projectId: PROJECT_A, hackathonId: EDITION, atMs: IN_FINAL });
    const focus = panel.submissionFocus!;
    expect(focus).toMatchObject({
      open: true, submissionStatus: "not_checked", deadlineIsOfficial: true,
      deadline: "2026-10-12T21:59:00.000Z", completedBySubmission: false,
    });
    const by = Object.fromEntries(focus.items.map((item) => [item.key, item]));
    expect(by.presentation).toMatchObject({ requirement: "required", present: true });
    expect(by.pitchVideo).toMatchObject({ requirement: "required", present: false });
    expect(by.repo).toMatchObject({ requirement: "optional", present: false });
    expect(by.website.requirement).toBe("unknown");
  });

  it("says a confirmed on-time submission completed the period, and marks a late one late", async () => {
    await writeReportingConfig(db, {
      hackathonId: EDITION, finalPeriodStartDate: "2026-10-05",
      officialSubmissionDeadline: "2026-10-12T21:59:00.000Z", nudgeWeekday: 3, nudgeTime: "12:00",
    });
    await rows(`UPDATE hq_project_onboarding SET submission_status='submitted',submitted_at='2026-10-06T10:00:00Z' WHERE project_id=$1`, [PROJECT_A]);
    await rows(`UPDATE hq_project_onboarding SET submission_status='submitted',submitted_at='2026-10-13T10:00:00Z' WHERE project_id=$1`, [PROJECT_B]);

    const onTime = (await teamReportingPanel(alice(), { projectId: PROJECT_A, hackathonId: EDITION, atMs: IN_FINAL })).submissionFocus!;
    expect(onTime).toMatchObject({ onTime: true, completedBySubmission: true });
    const late = (await teamReportingPanel(member("bob") as Extract<Actor, { kind: "member" }>, { projectId: PROJECT_B, hackathonId: EDITION, atMs: IN_FINAL })).submissionFocus!;
    expect(late).toMatchObject({ onTime: false, completedBySubmission: false });
  });

  it("keeps the submission detail after the period ends, and says the period is no longer open", async () => {
    const panel = await teamReportingPanel(alice(), { projectId: PROJECT_A, hackathonId: EDITION, atMs: AFTER_FINAL });
    expect(panel.current).toBeNull();
    expect(panel.submissionFocus).toMatchObject({ open: false, period: expect.objectContaining({ endDate: "2026-10-12" }) });
  });

  it("tells the team a reconciliation is still open rather than claiming they did not submit", async () => {
    await closeDuePeriods(db, { atMs: AFTER_FINAL, hackathonId: EDITION });
    await reconcileSubmissions(db, { hackathonId: EDITION, atMs: AFTER_FINAL, fetcher: brokenFetch });
    const focus = (await teamReportingPanel(alice(), { projectId: PROJECT_A, hackathonId: EDITION, atMs: AFTER_FINAL })).submissionFocus!;
    expect(focus.reconciliation).toMatchObject({ state: "pending", submissionStatus: null, onTime: null });
    expect(focus.submissionStatus).toBe("not_checked");
  });

  it("gives the assigned Captain the same view the team gets, from the same composition", async () => {
    await seedAssignedCaptain("cap", PROJECT_A);
    await rows(`UPDATE hq_project_onboarding SET submission_status='submitted',submitted_at='2026-10-06T10:00:00Z' WHERE project_id=$1`, [PROJECT_A]);
    const board = await captainReportingBoard(member("cap", ["captain"]) as Extract<Actor, { kind: "member" }>, EDITION, db, IN_FINAL);
    const card = board.cards.find((row) => row.status.projectId === PROJECT_A)!;
    const team = (await teamReportingPanel(alice(), { projectId: PROJECT_A, hackathonId: EDITION, atMs: IN_FINAL })).submissionFocus!;
    expect(card.submissionFocus).toEqual(team);
  });

  it("serializes no completion basis and no entry count to the team", async () => {
    // The same rule `TeamPeriodView` follows, and it matters here because the
    // panel is handed whole to a client component: a team must not be able to
    // read off that a Captain wrote a note they may not see. A sensitive note
    // is what makes this real, so one is written first.
    await seedAssignedCaptain("cap", PROJECT_A);
    await createUpdate(member("cap", ["captain"]), {
      projectId: PROJECT_A, hackathonId: EDITION, body: "A private word about Alpha", visibility: "sensitive", atMs: IN_FINAL,
    });
    const panel = await teamReportingPanel(alice(), { projectId: PROJECT_A, hackathonId: EDITION, atMs: IN_FINAL });
    // The team is told nothing about it, not even a completion: a Captain's
    // note never completes the team's week.
    expect(panel.current).toMatchObject({ completed: false });
    expect(panel.entries).toEqual([]);
    const serialized = JSON.stringify(panel.submissionFocus);
    expect(serialized).not.toContain("basis");
    expect(serialized).not.toContain("A private word");
    expect(Object.keys(panel.submissionFocus!.period).sort())
      .toEqual(["completed", "endDate", "endsAt", "periodId", "periodSequence", "startDate", "startsAt"]);
  });

  it("counts the edition's periods for the Week n of N line, and names the Captain's handle from their Telegram identity", async () => {
    await seedAssignedCaptain("cap", PROJECT_A);
    const captain = member("cap", ["captain"]) as Extract<Actor, { kind: "member" }>;
    const project = { id: PROJECT_A, name: "Alpha", hackathonId: EDITION };
    const [summary] = await memberWeekSummaries([project], db, IN_FINAL);
    const panel = await teamReportingPanel(alice(), { projectId: PROJECT_A, hackathonId: EDITION, atMs: IN_FINAL });
    const board = await captainReportingBoard(captain, EDITION, db, IN_FINAL);
    // Three weekly periods and the final one: four, the last of which is open now.
    expect(summary.totalPeriods).toBe(4);
    expect(panel.totalPeriods).toBe(4);
    expect(board.week).toEqual({ sequence: 4, total: 4 });
    // A count only: nothing about the weeks themselves rides along on Home.
    expect(JSON.stringify(summary)).not.toMatch(/"basis"|"entries"|"history"/);
    // Outside the campaign there is no week to name, and the count still stands.
    expect((await captainReportingBoard(captain, EDITION, db, AFTER_FINAL)).week).toBeNull();
    expect((await memberWeekSummaries([project], db, AFTER_FINAL))[0].totalPeriods).toBe(4);

    // The handle: nothing, then the contact typed on the old form, then the
    // Telegram username the moment one is linked.
    expect(board.captainContact).toBeNull();
    await rows("UPDATE hq_builder_profiles SET captain_contact='@typed_handle' WHERE id='cap'");
    expect((await captainReportingBoard(captain, EDITION, db, IN_FINAL)).captainContact).toBe("@typed_handle");
    await rows(
      `INSERT INTO hq_auth_account(id,issuer,"accountId","providerId","userId") VALUES('telegram-cap','https://oauth.telegram.org','tg-cap','telegram','cap')`,
    );
    await rows(
      `INSERT INTO hq_auth_telegram_identity(user_id,provider_subject,telegram_user_id,username) VALUES('cap','tg-cap',7000000000123,'cap_handle')`,
    );
    expect((await captainReportingBoard(captain, EDITION, db, IN_FINAL)).captainContact).toBe("@cap_handle");
  });
});

describe("the bounded refresh during the final period", () => {
  it("leaves source work for another pass when the caller's deadline is too close", async () => {
    await rows(`UPDATE hq_reporting_config SET submission_refresh_minutes=15 WHERE hackathon_id=$1`, [EDITION]);
    const fetcher = stubFetch({ alice: detailBody("alice"), bob: detailBody("bob") });
    expect(await refreshDueSubmissions(db, { atMs: IN_FINAL, fetcher, deadlineMs: Date.now() + 500 }))
      .toMatchObject({ attempted: 0, stoppedOnBudget: true });
    expect(fetcher.calls).toHaveLength(0);
  });
  it("does nothing at all until an admin configures an interval", async () => {
    expect(await dueSubmissionRefreshes(db, { atMs: IN_FINAL, hackathonId: EDITION })).toEqual([]);
  });

  it("offers every stale project once an interval is set, and nothing outside the final period", async () => {
    await rows(`UPDATE hq_reporting_config SET submission_refresh_minutes=60 WHERE hackathon_id=$1`, [EDITION]);
    expect((await dueSubmissionRefreshes(db, { atMs: IN_FINAL, hackathonId: EDITION })).map((row) => row.projectId).sort())
      .toEqual([PROJECT_A, PROJECT_B].sort());
    // A weekly week is not the final period, and neither is the time after it.
    expect(await dueSubmissionRefreshes(db, { atMs: Date.parse("2026-09-16T09:00:00Z"), hackathonId: EDITION })).toEqual([]);
    expect(await dueSubmissionRefreshes(db, { atMs: AFTER_FINAL, hackathonId: EDITION })).toEqual([]);
  });

  it("leaves a project alone until its interval has passed, and skips a paused one", async () => {
    await rows(`UPDATE hq_reporting_config SET submission_refresh_minutes=60 WHERE hackathon_id=$1`, [EDITION]);
    await rows(`UPDATE hq_project_onboarding SET source_checked_at=$2 WHERE project_id=$1`, [PROJECT_A, new Date(IN_FINAL - 10 * 60_000).toISOString()]);
    await rows(`UPDATE hq_reporting_eligibility SET paused_at=now() WHERE project_id=$1`, [PROJECT_B]);
    expect(await dueSubmissionRefreshes(db, { atMs: IN_FINAL, hackathonId: EDITION })).toEqual([]);
  });

  it("uses the last attempt to back off failing sources and lets other projects get checked", async () => {
    await rows(`UPDATE hq_reporting_config SET submission_refresh_minutes=60 WHERE hackathon_id=$1`, [EDITION]);
    await rows(`UPDATE hq_project_onboarding SET source_status='error', source_checked_at='2026-09-20T10:00:00Z', source_attempted_at=$2 WHERE project_id=$1`,
      [PROJECT_A, new Date(IN_FINAL - 5 * 60_000).toISOString()]);
    expect((await dueSubmissionRefreshes(db, { atMs: IN_FINAL, hackathonId: EDITION, limit: 1 })).map((row) => row.projectId))
      .toEqual([PROJECT_B]);
    expect((await dueSubmissionRefreshes(db, { atMs: IN_FINAL + 3_600_000, hackathonId: EDITION })).map((row) => row.projectId))
      .toContain(PROJECT_A);
    expect((await readSubmissionSnapshots(db, [PROJECT_A])).get(PROJECT_A)?.sourceCheckedAt)
      .toBe("2026-09-20T10:00:00.000Z");
  });

  it("takes no more than the batch it is given", async () => {
    await rows(`UPDATE hq_reporting_config SET submission_refresh_minutes=15 WHERE hackathon_id=$1`, [EDITION]);
    expect(await dueSubmissionRefreshes(db, { atMs: IN_FINAL, hackathonId: EDITION, limit: 1 })).toHaveLength(1);
  });

  it("keeps the last known status and records the failure when the source cannot be read", async () => {
    await rows(`UPDATE hq_reporting_config SET submission_refresh_minutes=15 WHERE hackathon_id=$1`, [EDITION]);
    await rows(`UPDATE hq_project_onboarding SET submission_status='submitted',submitted_at='2026-10-06T10:00:00Z',source_status='ok',source_checked_at='2026-10-06T10:00:00Z' WHERE project_id=$1`, [PROJECT_A]);
    const summary = await refreshDueSubmissions(db, { atMs: IN_FINAL, hackathonId: EDITION, fetcher: brokenFetch });
    expect(summary.failed).toBeGreaterThan(0);
    const snapshot = (await readSubmissionSnapshots(db, [PROJECT_A])).get(PROJECT_A)!;
    // Green does not turn red because a request failed.
    expect(snapshot).toMatchObject({ submissionStatus: "submitted", sourceStatus: "error" });
    expect(snapshot.sourceCheckedAt).toBe("2026-10-06T10:00:00.000Z");
  });
});

describe("the reconciliation when the final period closes", () => {
  async function closeFinal(atMs = AFTER_FINAL) {
    const { closed } = await closeDuePeriods(db, { atMs, hackathonId: EDITION });
    return closed;
  }

  it("stops after a slow failed request instead of overrunning the job deadline", async () => {
    await closeFinal();
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const fetcher: ColosseumFetch = async (...args) => { clock += 6_000; return brokenFetch(...args); };
      expect(await reconcileSubmissions(db, { hackathonId: EDITION, atMs: AFTER_FINAL, fetcher }))
        .toMatchObject({ attempted: 1, stillPending: 1, stoppedOnBudget: true });
    } finally {
      now.mockRestore();
    }
  });

  it("keeps unknown evidence pending even after a successful source request", async () => {
    await closeFinal();
    const unknownDb: BuilderDatabase = {
      ...db,
      query: async (text, values) => {
        const result = await db.query(text, values);
        return text.includes("project_url, submission_status, submitted_at")
          ? { ...result, rows: result.rows.map((row) => ({ ...row, submission_status: "not_checked", submitted_at: null })) }
          : result;
      },
    };
    const fetcher = stubFetch({ alice: detailBody("alice"), bob: detailBody("bob") });
    expect(await reconcileSubmissions(unknownDb, { hackathonId: EDITION, atMs: AFTER_FINAL, fetcher }))
      .toMatchObject({ attempted: 2, resolved: 0, stillPending: 2 });
    expect((await readSubmissionReconciliations(db, { projectIds: [PROJECT_A, PROJECT_B, BARE_PROJECT] })).every((row) => row.state === "pending" && row.lastError === "submission_unknown"))
      .toBe(true);
  });

  it("keeps the deadline recorded at closure when settings change during an outage", async () => {
    await rows(`UPDATE hq_reporting_config SET official_submission_deadline='2026-10-10T20:00:00Z' WHERE hackathon_id=$1`, [EDITION]);
    await closeFinal();
    await rows(`UPDATE hq_reporting_config SET official_submission_deadline='2026-10-12T20:00:00Z' WHERE hackathon_id=$1`, [EDITION]);
    const fetcher = stubFetch({ alice: detailBody("alice", { submittedAt: "2026-10-11T18:00:00Z" }), bob: detailBody("bob") });
    expect(await reconcileSubmissions(db, { hackathonId: EDITION, atMs: AFTER_FINAL, fetcher }))
      .toMatchObject({ corrected: 0 });
    expect((await readSubmissionReconciliations(db, { projectIds: [PROJECT_A, PROJECT_B, BARE_PROJECT] })).find((row) => row.projectId === PROJECT_A))
      .toMatchObject({ deadline: "2026-10-10T20:00:00.000Z", onTime: false });
  });

  it("opens one row per accountable imported project, and none for a CRM-only project", async () => {
    await seedProject(BARE_PROJECT, "CRM only");
    await enableReporting(db, { projectId: BARE_PROJECT, hackathonId: EDITION, operatorId: OPERATOR_ID });
    await closeFinal();
    const reconciliations = await readSubmissionReconciliations(db, { projectIds: [PROJECT_A, PROJECT_B, BARE_PROJECT] });
    expect(reconciliations.map((row) => row.projectId).sort()).toEqual([PROJECT_A, PROJECT_B].sort());
    expect(reconciliations.every((row) => row.state === "pending")).toBe(true);
  });

  it("opens nothing twice, and opens the missing rows for a period that was already closed", async () => {
    const period = await finalPeriod();
    await closePeriod(db, { periodId: period.id, actor: OPERATOR, atMs: AFTER_FINAL });
    // The closure happened with no reconciliation step: the catch-up run is
    // what has to notice.
    expect(await readSubmissionReconciliations(db, { projectIds: [PROJECT_A, PROJECT_B, BARE_PROJECT] })).toEqual([]);
    await closeFinal();
    expect(await readSubmissionReconciliations(db, { projectIds: [PROJECT_A, PROJECT_B, BARE_PROJECT] })).toHaveLength(2);
    await closeFinal();
    expect(await readSubmissionReconciliations(db, { projectIds: [PROJECT_A, PROJECT_B, BARE_PROJECT] })).toHaveLength(2);
  });

  it("stays pending and claims nothing when Colosseum cannot be reached", async () => {
    await closeFinal();
    const summary = await reconcileSubmissions(db, { hackathonId: EDITION, atMs: AFTER_FINAL, fetcher: brokenFetch });
    expect(summary).toMatchObject({ resolved: 0, stillPending: 2, corrected: 0 });
    const rowsBack = await readSubmissionReconciliations(db, { projectIds: [PROJECT_A, PROJECT_B, BARE_PROJECT] });
    for (const row of rowsBack) {
      expect(row.state).toBe("pending");
      // The plan: "do not claim an unverified submission failure".
      expect(row.submissionStatus).toBeNull();
      expect(row.onTime).toBeNull();
      expect(row.attempts).toBe(1);
    }
    // And nothing about the recorded weeks moved.
    const period = await finalPeriod();
    expect((await listPeriodOutcomes(db, period.id)).every((outcome) => outcome.correctedCompleted === null)).toBe(true);
  });

  it("corrects a missed final period, with an audit event, when delayed evidence shows an on-time submission", async () => {
    await closeFinal();
    const period = await finalPeriod();
    expect((await listPeriodOutcomes(db, period.id)).find((outcome) => outcome.projectId === PROJECT_A))
      .toMatchObject({ completed: false, basis: "none" });

    // The evidence arrives a day late, and names a submission made in time.
    const fetcher = stubFetch({
      alice: detailBody("alice", { submittedAt: "2026-10-11T18:00:00.000Z" }),
      bob: detailBody("bob", { submittedAt: null }),
    });
    const summary = await reconcileSubmissions(db, { hackathonId: EDITION, atMs: AFTER_FINAL, fetcher });
    expect(summary).toMatchObject({ resolved: 2, stillPending: 0, corrected: 1 });

    const outcome = (await listPeriodOutcomes(db, period.id)).find((row) => row.projectId === PROJECT_A)!;
    // The original factual answer is never rewritten; the correction is
    // written beside it with its reason.
    expect(outcome.completed).toBe(false);
    expect(outcome.correctedCompleted).toBe(true);
    expect(outcome.correctionReason).toContain("2026-10-11T18:00:00.000Z");
    const audits = await rows(`SELECT kind, actor_kind, metadata FROM hq_audit_events WHERE kind='reporting.outcome_corrected'`);
    expect(audits).toHaveLength(1);
    // A job has no operator id of its own and is audited as the system.
    expect(audits[0].actor_kind).toBe("system");

    // The one that did not submit is resolved and corrected nothing.
    const bob = (await readSubmissionReconciliations(db, { projectIds: [PROJECT_A, PROJECT_B, BARE_PROJECT] })).find((row) => row.projectId === PROJECT_B)!;
    expect(bob).toMatchObject({ state: "resolved", submissionStatus: "not_submitted", onTime: null, outcomeCorrected: false });
  });

  it("records a late submission as late and leaves the missed period exactly as it was", async () => {
    await writeReportingConfig(db, {
      hackathonId: EDITION, finalPeriodStartDate: "2026-10-05",
      officialSubmissionDeadline: "2026-10-12T21:59:00.000Z", nudgeWeekday: 3, nudgeTime: "12:00",
    });
    await closeFinal();
    const period = await finalPeriod();
    const fetcher = stubFetch({
      alice: detailBody("alice", { submittedAt: "2026-10-13T02:00:00.000Z" }),
      bob: detailBody("bob", { submittedAt: null }),
    });
    const summary = await reconcileSubmissions(db, { hackathonId: EDITION, atMs: AFTER_FINAL, fetcher });
    expect(summary).toMatchObject({ resolved: 2, corrected: 0 });

    const alice = (await readSubmissionReconciliations(db, { projectIds: [PROJECT_A, PROJECT_B, BARE_PROJECT] })).find((row) => row.projectId === PROJECT_A)!;
    expect(alice).toMatchObject({ state: "resolved", submissionStatus: "submitted", onTime: false, outcomeCorrected: false });
    const outcome = (await listPeriodOutcomes(db, period.id)).find((row) => row.projectId === PROJECT_A)!;
    expect(outcome).toMatchObject({ completed: false, correctedCompleted: null });
    expect(await rows(`SELECT 1 FROM hq_audit_events WHERE kind='reporting.outcome_corrected'`)).toEqual([]);
  });

  it("corrects nothing for a period a written update already completed, and resolves it anyway", async () => {
    await createUpdate(member("alice"), { projectId: PROJECT_A, hackathonId: EDITION, body: "Submitted, deck attached", atMs: IN_FINAL });
    await closeFinal();
    const fetcher = stubFetch({
      alice: detailBody("alice", { submittedAt: "2026-10-11T18:00:00.000Z" }),
      bob: detailBody("bob", { submittedAt: null }),
    });
    const summary = await reconcileSubmissions(db, { hackathonId: EDITION, atMs: AFTER_FINAL, fetcher });
    expect(summary).toMatchObject({ resolved: 2, corrected: 0 });
    const period = await finalPeriod();
    const outcome = (await listPeriodOutcomes(db, period.id)).find((row) => row.projectId === PROJECT_A)!;
    expect(outcome).toMatchObject({ completed: true, basis: "entry", correctedCompleted: null });
  });

  it("keeps trying on a later pass, and resolves when the source comes back", async () => {
    await closeFinal();
    await reconcileSubmissions(db, { hackathonId: EDITION, atMs: AFTER_FINAL, fetcher: brokenFetch });
    const fetcher = stubFetch({
      alice: detailBody("alice", { submittedAt: "2026-10-11T18:00:00.000Z" }),
      bob: detailBody("bob", { submittedAt: null }),
    });
    const summary = await reconcileSubmissions(db, { hackathonId: EDITION, atMs: AFTER_FINAL + 3_600_000, fetcher });
    expect(summary).toMatchObject({ resolved: 2, stillPending: 0, corrected: 1 });
    expect((await readSubmissionReconciliations(db, { projectIds: [PROJECT_A, PROJECT_B, BARE_PROJECT] })).every((row) => row.state === "resolved")).toBe(true);
    // A second reconciliation pass has nothing left to do and corrects nothing twice.
    expect(await reconcileSubmissions(db, { hackathonId: EDITION, atMs: AFTER_FINAL + 7_200_000, fetcher }))
      .toMatchObject({ attempted: 0, resolved: 0, corrected: 0 });
    expect(await rows(`SELECT 1 FROM hq_audit_events WHERE kind='reporting.outcome_corrected'`)).toHaveLength(1);
  });

  it("excuses a paused project from the reconciliation entirely", async () => {
    await rows(`UPDATE hq_reporting_eligibility SET paused_at='2026-10-01T00:00:00Z' WHERE project_id=$1`, [PROJECT_B]);
    await rows(`INSERT INTO hq_reporting_pause_intervals(project_id,hackathon_id,paused_at) VALUES($1,$2,'2026-10-01T00:00:00Z')`, [PROJECT_B, EDITION]);
    await closeFinal();
    expect((await readSubmissionReconciliations(db, { projectIds: [PROJECT_A, PROJECT_B, BARE_PROJECT] })).map((row) => row.projectId)).toEqual([PROJECT_A]);
  });

  it("opens nothing for a weekly period, only for the submission one", async () => {
    const weekOne = (await listReportingPeriods(db, EDITION)).find((period) => period.sequence === 1)!;
    expect((await closePeriod(db, { periodId: weekOne.id, actor: OPERATOR, atMs: AFTER_FINAL })).ok).toBe(true);
    expect(await openSubmissionReconciliations(db, { hackathonId: EDITION })).toBe(0);
    expect(await readSubmissionReconciliations(db, { projectIds: [PROJECT_A, PROJECT_B, BARE_PROJECT] })).toEqual([]);
  });
});
