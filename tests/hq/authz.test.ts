// The actor representation and the central authorization helpers, against
// the real schema on PGlite. Membership and capability facts come from real
// rows; the phase 4 assignment hook is injected. The matrix below encodes
// plan section 5: operators have full access only through their kind, a
// member is evaluated per resource, a `captain` grant opens nothing on its
// own, a foreign project looks exactly like a missing one, and a revocation
// is visible on the next call.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  builderDatabase: vi.fn(),
  currentUser: vi.fn(),
  requireUser: vi.fn(),
  currentMember: vi.fn(),
  requireMember: vi.fn(),
}));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));
vi.mock("@/lib/hq/auth", () => ({ currentUser: mocks.currentUser, requireUser: mocks.requireUser }));
vi.mock("@/lib/hq/member-auth", () => ({ currentMember: mocks.currentMember, requireMember: mocks.requireMember }));

import { currentActor, requireMemberActor, requireOperatorActor, type Actor } from "@/lib/hq/actor";
import {
  assertHackathonMatches,
  authorizeProjectAction,
  canEditEntry,
  canReadRevisionHistory,
  entryAudience,
  getActorCapabilities,
  isAssignedCaptain,
  isTeamMember,
  requireOperator,
  type AuthzLoaders,
  type Entry,
  type ProjectAction,
} from "@/lib/hq/authz";
import { loadCurrentAssignment, loadEntry, loadProjectEdition, loadTeamMembership } from "@/lib/hq/authz-sql";
import type { BuilderDatabase, BuilderQuery } from "@/lib/hq/builder-db";
import { BuilderError } from "@/lib/hq/builder-types";
import { grantCapability, revokeCapability } from "@/lib/hq/capabilities";
import { assignCaptain, unassignCaptain } from "@/lib/hq/captains";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR_ID = "00000000-0000-4000-8000-000000000001";
const EDITION_A = 6;
const EDITION_B = 7;
const PROJECT_A = "00000000-0000-4000-8000-00000000000a"; // edition A, verified, lead-a + member-a
const PROJECT_B = "00000000-0000-4000-8000-00000000000b"; // edition A, verified, lead-b + cap as a roster member
const PROJECT_C = "00000000-0000-4000-8000-00000000000c"; // edition B, verified, lead-c
const PROJECT_P = "00000000-0000-4000-8000-00000000000d"; // edition A, pending claim by lead-p
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";
const ACTIONS: ProjectAction[] = ["read", "update.create", "update.edit", "membership.change", "assignment.read"];

const OPERATOR: Actor = { kind: "operator", id: OPERATOR_ID, displayName: "Operator" };
const JOB: Actor = { kind: "job", audience: "reminders" };
const member = (id: string, capabilities: Array<"captain"> = []): Actor =>
  ({ kind: "member", id, name: id, email: null, capabilities: new Set(capabilities), telegram: null });
/** The phase 4 hook, injected: `captainUserId` is the current Captain of `projectId` and nothing else has one. */
const assigned = (captainUserId: string, projectId: string): Partial<AuthzLoaders> => ({
  loadCurrentAssignment: async (id) => (id === projectId ? { captainUserId } : null),
});
const entry = (author: string, visibility: Entry["visibility"], projectId = PROJECT_A, hackathonId = EDITION_A): Entry =>
  ({ id: `${author}-${visibility}`, projectId, hackathonId, authorUserId: author, visibility });

let pg: PGlite;
let db: BuilderDatabase;
const rows = async (text: string, values: unknown[] = []) => (await pg.query(text, values)).rows as Record<string, unknown>[];
const grant = (userId: string) => grantCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId, capability: "captain", reason: "test" });
const revoke = (userId: string) => revokeCapability(db, { actor: { kind: "operator", id: OPERATOR_ID }, byOperatorId: OPERATOR_ID, userId, capability: "captain", reason: "test" });

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  mocks.builderDatabase.mockReturnValue(db);
}, 30_000);

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.builderDatabase.mockReturnValue(db);
  await pg.exec("TRUNCATE hq_users, hq_hackathons, hq_builder_profiles, hq_project_statuses, hq_project_forecasts, hq_audit_events, hq_auth_user RESTART IDENTITY CASCADE");
  await rows("INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'operator','Operator','unused')", [OPERATOR_ID]);
  await pg.exec(`
    INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES
      (${EDITION_A},'edition-a','Edition A','2026-09-14','2026-10-12'),
      (${EDITION_B},'edition-b','Edition B','2027-01-01','2027-02-01');
    INSERT INTO hq_builder_profiles(id,email,name) VALUES
      ('lead-a','lead-a@example.test','Lead A'),('member-a',NULL,'Member A'),('lead-b','lead-b@example.test','Lead B'),
      ('lead-c','lead-c@example.test','Lead C'),('lead-p','lead-p@example.test','Lead P'),
      ('cap',NULL,'Captain'),('cap2','cap2@example.test','Other Captain'),('plain','plain@example.test','Plain');
    INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('onboarding','Onboarding','accent',true,100);
    INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES('unassessed','Not assessed','muted',100);
  `);
  const projects = [
    [PROJECT_A, EDITION_A, "lead-a", "verified", 9001],
    [PROJECT_B, EDITION_A, "lead-b", "verified", 9002],
    [PROJECT_C, EDITION_B, "lead-c", "verified", 9003],
    [PROJECT_P, EDITION_A, "lead-p", "pending", 9004],
  ] as const;
  for (const [id, edition, owner, verification, external] of projects) {
    await rows(`INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
      SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f`, [id, edition, `Project ${owner}`]);
    await rows(`INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,verification,lead_username)
      VALUES($1,$2,$3,$4,$5,'{}',$5,$6,$5)`, [id, edition, external, `https://colosseum.com/arena/projects/explore/${owner}`, owner, verification]);
    await rows("INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,$2,$2,$2,now())", [id, owner]);
  }
  // A joined teammate, an unclaimed roster row, and cap on project B's roster.
  await rows("INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,'Member A','member_a','member-a',now())", [PROJECT_A]);
  await rows("INSERT INTO hq_project_members(project_id,name,colosseum_username) VALUES($1,'Unclaimed','unclaimed')", [PROJECT_A]);
  await rows("INSERT INTO hq_project_members(project_id,name,colosseum_username,builder_user_id,joined_at) VALUES($1,'Captain','cap_handle','cap',now())", [PROJECT_B]);
});

afterAll(async () => { await pg.close(); });

describe("loaders", () => {
  it("loadProjectEdition reads the core record and treats an unknown or malformed id as missing", async () => {
    expect(await loadProjectEdition(db, PROJECT_A)).toEqual({ projectId: PROJECT_A, hackathonId: EDITION_A });
    expect(await loadProjectEdition(db, PROJECT_C)).toEqual({ projectId: PROJECT_C, hackathonId: EDITION_B });
    expect(await loadProjectEdition(db, UNKNOWN)).toBeNull();
    expect(await loadProjectEdition(db, "not-a-uuid")).toBeNull();
    expect(await loadProjectEdition(db, "")).toBeNull();
  });

  it("loadTeamMembership returns the verified owner or joined member and nothing for anyone else", async () => {
    expect(await loadTeamMembership(db, { userId: "lead-a", projectId: PROJECT_A })).toEqual({ projectId: PROJECT_A, hackathonId: EDITION_A, role: "owner" });
    expect(await loadTeamMembership(db, { userId: "member-a", projectId: PROJECT_A })).toEqual({ projectId: PROJECT_A, hackathonId: EDITION_A, role: "member" });
    expect(await loadTeamMembership(db, { userId: "cap", projectId: PROJECT_B })).toEqual({ projectId: PROJECT_B, hackathonId: EDITION_A, role: "member" });
    // Unrelated, other team, a pending claim, an unclaimed roster row, unknown and malformed ids.
    expect(await loadTeamMembership(db, { userId: "plain", projectId: PROJECT_A })).toBeNull();
    expect(await loadTeamMembership(db, { userId: "lead-a", projectId: PROJECT_B })).toBeNull();
    expect(await loadTeamMembership(db, { userId: "lead-p", projectId: PROJECT_P })).toBeNull();
    expect(await loadTeamMembership(db, { userId: "unclaimed", projectId: PROJECT_A })).toBeNull();
    expect(await loadTeamMembership(db, { userId: "lead-a", projectId: UNKNOWN })).toBeNull();
    expect(await loadTeamMembership(db, { userId: "lead-a", projectId: "not-a-uuid" })).toBeNull();
  });

  it("loadCurrentAssignment reads hq_captain_assignments: no row, a current row, an ended row, and a malformed id without a query", async () => {
    expect(await loadCurrentAssignment(db, PROJECT_A)).toBeNull();
    await rows(
      "INSERT INTO hq_captain_assignments (project_id, captain_user_id, assigned_by_user_id) VALUES ($1, $2, $3)",
      [PROJECT_A, "cap", OPERATOR_ID],
    );
    expect(await loadCurrentAssignment(db, PROJECT_A)).toEqual({ captainUserId: "cap" });
    // A project with no assignment of its own stays null even once another project has one.
    expect(await loadCurrentAssignment(db, PROJECT_B)).toBeNull();
    await rows(
      "UPDATE hq_captain_assignments SET unassigned_at = now(), unassigned_by_user_id = $2 WHERE project_id = $1 AND unassigned_at IS NULL",
      [PROJECT_A, OPERATOR_ID],
    );
    expect(await loadCurrentAssignment(db, PROJECT_A)).toBeNull();
    const refuseQuery: BuilderQuery = { query: async () => { throw new Error("loadCurrentAssignment queried the database for a malformed id"); } };
    expect(await loadCurrentAssignment(refuseQuery, "not-a-uuid")).toBeNull();
  });

  it("loadEntry reads a reporting entry with its project's edition, and treats a malformed id as missing without a query", async () => {
    const [period] = await rows(
      `INSERT INTO hq_reporting_periods (hackathon_id, sequence, mode, start_date, end_date, starts_at, ends_at)
       VALUES ($1, 1, 'weekly', '2026-09-14', '2026-09-20', '2026-09-13T22:00:00Z', '2026-09-20T22:00:00Z') RETURNING id::text AS id`,
      [EDITION_A],
    );
    const [entry] = await rows(
      `INSERT INTO hq_reporting_entries (project_id, period_id, author_kind, author_id, body, visibility)
       VALUES ($1, $2, 'member', 'lead-a', 'Shipped the importer', 'shared') RETURNING id::text AS id`,
      [PROJECT_A, String(period.id)],
    );
    expect(await loadEntry(db, String(entry.id))).toEqual({
      id: String(entry.id), projectId: PROJECT_A, hackathonId: EDITION_A, authorUserId: "lead-a", visibility: "shared",
    });

    // An operator author is namespaced on the way out, so no member id can
    // ever be read back as matching it.
    const [byOperator] = await rows(
      `INSERT INTO hq_reporting_entries (project_id, period_id, author_kind, author_id, body, visibility)
       VALUES ($1, $2, 'operator', $3, 'Corrected on the team''s behalf', 'sensitive') RETURNING id::text AS id`,
      [PROJECT_A, String(period.id), OPERATOR_ID],
    );
    expect(await loadEntry(db, String(byOperator.id))).toEqual({
      id: String(byOperator.id), projectId: PROJECT_A, hackathonId: EDITION_A, authorUserId: `operator:${OPERATOR_ID}`, visibility: "sensitive",
    });

    expect(await loadEntry(db, UNKNOWN)).toBeNull();
    const refuseQuery: BuilderQuery = { query: async () => { throw new Error("loadEntry queried the database for a malformed id"); } };
    expect(await loadEntry(refuseQuery, "not-a-uuid")).toBeNull();
  });
});

describe("authorizeProjectAction", () => {
  it("grants an operator every action through their kind, without a lookup", async () => {
    for (const action of ACTIONS) {
      expect(await authorizeProjectAction(OPERATOR, { projectId: UNKNOWN, hackathonId: EDITION_A, action })).toEqual({ allowed: true, via: "operator" });
    }
    expect(mocks.builderDatabase).not.toHaveBeenCalled();
  });

  it("never grants a member through the operator branch, and a job nothing at all", async () => {
    for (const action of ACTIONS) {
      const result = await authorizeProjectAction(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION_A, action });
      expect(result.allowed && result.via).toBe("member");
      expect(await authorizeProjectAction(JOB, { projectId: PROJECT_A, hackathonId: EDITION_A, action })).toEqual({ allowed: false, reason: "no_capability" });
    }
  });

  it("gives a team member read, create, edit and the Captain assignment; membership changes are the lead's alone", async () => {
    for (const action of ["read", "update.create", "update.edit", "assignment.read"] as const) {
      expect(await authorizeProjectAction(member("member-a"), { projectId: PROJECT_A, hackathonId: EDITION_A, action })).toEqual({ allowed: true, via: "member" });
    }
    expect(await authorizeProjectAction(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION_A, action: "membership.change" })).toEqual({ allowed: true, via: "member" });
    expect(await authorizeProjectAction(member("member-a"), { projectId: PROJECT_A, hackathonId: EDITION_A, action: "membership.change" })).toEqual({ allowed: false, reason: "not_member" });
  });

  it("makes a foreign, other-edition, pending, unknown or malformed project indistinguishable from a missing one", async () => {
    const cases: Array<[string, string, number]> = [
      ["plain", PROJECT_A, EDITION_A],
      ["lead-a", PROJECT_B, EDITION_A],
      ["lead-a", PROJECT_C, EDITION_A],
      ["lead-a", PROJECT_C, EDITION_B],
      ["lead-p", PROJECT_P, EDITION_A],
      ["unclaimed", PROJECT_A, EDITION_A],
      ["lead-a", UNKNOWN, EDITION_A],
      ["lead-a", "not-a-uuid", EDITION_A],
    ];
    for (const [userId, projectId, hackathonId] of cases) {
      for (const action of ACTIONS) {
        expect(await authorizeProjectAction(member(userId), { projectId, hackathonId, action }), `${userId} ${projectId} ${action}`).toEqual({ allowed: false, reason: "not_found" });
      }
    }
  });

  it("refuses a related project under the wrong edition", async () => {
    expect(await authorizeProjectAction(member("lead-a"), { projectId: PROJECT_A, hackathonId: EDITION_B, action: "read" })).toEqual({ allowed: false, reason: "wrong_edition" });
    expect(await authorizeProjectAction(member("member-a"), { projectId: PROJECT_A, hackathonId: 999, action: "update.edit" })).toEqual({ allowed: false, reason: "wrong_edition" });
    await grant("cap");
    expect(await authorizeProjectAction(member("cap"), { projectId: PROJECT_A, hackathonId: EDITION_B, action: "read" }, assigned("cap", PROJECT_A))).toEqual({ allowed: false, reason: "wrong_edition" });
  });

  it("gives a captain grant nothing without an assignment, and the shared surface with one", async () => {
    await grant("cap");
    for (const action of ACTIONS) {
      expect(await authorizeProjectAction(member("cap"), { projectId: PROJECT_A, hackathonId: EDITION_A, action })).toEqual({ allowed: false, reason: "not_assigned" });
    }
    for (const action of ["read", "update.create", "update.edit", "assignment.read"] as const) {
      expect(await authorizeProjectAction(member("cap"), { projectId: PROJECT_A, hackathonId: EDITION_A, action }, assigned("cap", PROJECT_A))).toEqual({ allowed: true, via: "captain" });
    }
    expect(await authorizeProjectAction(member("cap"), { projectId: PROJECT_A, hackathonId: EDITION_A, action: "membership.change" }, assigned("cap", PROJECT_A))).toEqual({ allowed: false, reason: "not_member" });
    // An assignment row for someone without the capability opens nothing either.
    expect(await authorizeProjectAction(member("plain"), { projectId: PROJECT_A, hackathonId: EDITION_A, action: "read" }, assigned("plain", PROJECT_A))).toEqual({ allowed: false, reason: "not_found" });
    // And an assignment to someone else is not this Captain's.
    expect(await authorizeProjectAction(member("cap"), { projectId: PROJECT_A, hackathonId: EDITION_A, action: "read" }, assigned("cap2", PROJECT_A))).toEqual({ allowed: false, reason: "not_assigned" });
  });

  it("lets an unassigned Captain learn nothing about projects outside the requested edition", async () => {
    await grant("cap");
    const cap = member("cap");
    // Project C lives in edition B. Asked for under edition A it must look
    // missing, exactly like an unknown id; under its own edition the answer
    // is the brief's not_assigned; only a matching assignment earns wrong_edition.
    for (const action of ACTIONS) {
      expect(await authorizeProjectAction(cap, { projectId: PROJECT_C, hackathonId: EDITION_A, action }), action).toEqual({ allowed: false, reason: "not_found" });
      expect(await authorizeProjectAction(cap, { projectId: UNKNOWN, hackathonId: EDITION_A, action }), action).toEqual({ allowed: false, reason: "not_found" });
      expect(await authorizeProjectAction(cap, { projectId: PROJECT_C, hackathonId: EDITION_B, action }), action).toEqual({ allowed: false, reason: "not_assigned" });
    }
    expect(await authorizeProjectAction(cap, { projectId: PROJECT_C, hackathonId: EDITION_A, action: "read" }, assigned("cap", PROJECT_C))).toEqual({ allowed: false, reason: "wrong_edition" });
    expect(await authorizeProjectAction(cap, { projectId: PROJECT_C, hackathonId: EDITION_A, action: "read" }, assigned("cap2", PROJECT_C))).toEqual({ allowed: false, reason: "not_found" });
    expect(await authorizeProjectAction(cap, { projectId: PROJECT_C, hackathonId: EDITION_B, action: "read" }, assigned("cap", PROJECT_C))).toEqual({ allowed: true, via: "captain" });
  });

  it("reads the grant from the database, never from the actor's own capability set", async () => {
    expect(await authorizeProjectAction(member("plain", ["captain"]), { projectId: PROJECT_A, hackathonId: EDITION_A, action: "read" }, assigned("plain", PROJECT_A))).toEqual({ allowed: false, reason: "not_found" });
    expect(await isAssignedCaptain(member("plain", ["captain"]), PROJECT_A, assigned("plain", PROJECT_A))).toBe(false);
    expect(await getActorCapabilities(member("plain", ["captain"]))).toEqual(new Set());
  });

  it("evaluates combined roles per resource", async () => {
    await grant("cap");
    const loaders = assigned("cap", PROJECT_A);
    const cap = member("cap");
    expect(await authorizeProjectAction(cap, { projectId: PROJECT_A, hackathonId: EDITION_A, action: "read" }, loaders)).toEqual({ allowed: true, via: "captain" });
    expect(await authorizeProjectAction(cap, { projectId: PROJECT_B, hackathonId: EDITION_A, action: "read" }, loaders)).toEqual({ allowed: true, via: "member" });
    expect(await authorizeProjectAction(cap, { projectId: PROJECT_C, hackathonId: EDITION_B, action: "read" }, loaders)).toEqual({ allowed: false, reason: "not_assigned" });
    // Membership on B is an ordinary member's, not the lead's; the assignment on A carries no membership right.
    expect(await authorizeProjectAction(cap, { projectId: PROJECT_B, hackathonId: EDITION_A, action: "membership.change" }, loaders)).toEqual({ allowed: false, reason: "not_member" });
    expect(await authorizeProjectAction(cap, { projectId: PROJECT_A, hackathonId: EDITION_A, action: "membership.change" }, loaders)).toEqual({ allowed: false, reason: "not_member" });
    expect(await isTeamMember(cap, PROJECT_B)).toBe(true);
    expect(await isTeamMember(cap, PROJECT_A)).toBe(false);
    expect(await isAssignedCaptain(cap, PROJECT_A, loaders)).toBe(true);
    expect(await isAssignedCaptain(cap, PROJECT_B, loaders)).toBe(false);
  });

  it("sees a revocation on the very next call, with the same actor object and no caching in between", async () => {
    const cap = member("cap");
    const loaders = assigned("cap", PROJECT_A);
    const request = { projectId: PROJECT_A, hackathonId: EDITION_A, action: "read" as const };
    expect(await authorizeProjectAction(cap, request, loaders)).toEqual({ allowed: false, reason: "not_found" });
    await grant("cap");
    expect(await authorizeProjectAction(cap, request, loaders)).toEqual({ allowed: true, via: "captain" });
    expect(await getActorCapabilities(cap)).toEqual(new Set(["captain"]));
    expect(await isAssignedCaptain(cap, PROJECT_A, loaders)).toBe(true);
    await revoke("cap");
    expect(await authorizeProjectAction(cap, request, loaders)).toEqual({ allowed: false, reason: "not_found" });
    expect(await getActorCapabilities(cap)).toEqual(new Set());
    expect(await isAssignedCaptain(cap, PROJECT_A, loaders)).toBe(false);
    await grant("cap");
    expect(await authorizeProjectAction(cap, request, loaders)).toEqual({ allowed: true, via: "captain" });
    // Membership is read fresh too: leaving the team ends access at once.
    expect(await authorizeProjectAction(member("member-a"), request)).toEqual({ allowed: true, via: "member" });
    await rows("UPDATE hq_project_members SET builder_user_id = NULL WHERE builder_user_id = 'member-a'");
    expect(await authorizeProjectAction(member("member-a"), request)).toEqual({ allowed: false, reason: "not_found" });
  });
});

describe("relationship predicates", () => {
  it("isTeamMember and isAssignedCaptain hold only for member actors with the relationship", async () => {
    await grant("cap");
    expect(await isTeamMember(member("lead-a"), PROJECT_A)).toBe(true);
    expect(await isTeamMember(member("member-a"), PROJECT_A)).toBe(true);
    expect(await isTeamMember(member("plain"), PROJECT_A)).toBe(false);
    expect(await isTeamMember(member("lead-p"), PROJECT_P)).toBe(false);
    expect(await isTeamMember(OPERATOR, PROJECT_A)).toBe(false);
    expect(await isTeamMember(JOB, PROJECT_A)).toBe(false);
    expect(await isAssignedCaptain(member("cap"), PROJECT_A)).toBe(false);
    expect(await isAssignedCaptain(member("cap"), PROJECT_A, assigned("cap", PROJECT_A))).toBe(true);
    expect(await isAssignedCaptain(member("plain"), PROJECT_A, assigned("plain", PROJECT_A))).toBe(false);
    expect(await isAssignedCaptain(OPERATOR, PROJECT_A, assigned(OPERATOR_ID, PROJECT_A))).toBe(false);
    expect(await isAssignedCaptain(JOB, PROJECT_A)).toBe(false);
  });

  it("getActorCapabilities is empty for operators and jobs and current for members", async () => {
    expect(await getActorCapabilities(OPERATOR)).toEqual(new Set());
    expect(await getActorCapabilities(JOB)).toEqual(new Set());
    expect(await getActorCapabilities(member("cap"))).toEqual(new Set());
    await grant("cap");
    expect(await getActorCapabilities(member("cap"))).toEqual(new Set(["captain"]));
  });
});

describe("entry audience", () => {
  const sharedByLead = entry("lead-a", "shared");
  const sharedByCap = entry("cap", "shared");
  const noteByCap = entry("cap", "sensitive");
  const noteByCap2 = entry("cap2", "sensitive");
  const all = [sharedByLead, sharedByCap, noteByCap, noteByCap2];

  it("operators read and write everything, and only they see revision history", async () => {
    for (const item of all) {
      expect(await entryAudience(item, OPERATOR)).toBe("read_write");
      expect(await canEditEntry(OPERATOR, item)).toBe(true);
    }
    expect(canReadRevisionHistory(OPERATOR)).toBe(true);
    expect(canReadRevisionHistory(member("lead-a"))).toBe(false);
    expect(canReadRevisionHistory(member("cap", ["captain"]))).toBe(false);
    expect(canReadRevisionHistory(JOB)).toBe(false);
  });

  it("team members read shared entries, edit their own, and never see a sensitive note", async () => {
    await grant("cap");
    const loaders = assigned("cap", PROJECT_A);
    expect(await entryAudience(sharedByLead, member("lead-a"), loaders)).toBe("read_write");
    expect(await entryAudience(sharedByCap, member("lead-a"), loaders)).toBe("read");
    expect(await entryAudience(sharedByLead, member("member-a"), loaders)).toBe("read");
    expect(await entryAudience(noteByCap, member("lead-a"), loaders)).toBe("none");
    expect(await entryAudience(noteByCap, member("member-a"), loaders)).toBe("none");
    expect(await canEditEntry(member("lead-a"), sharedByLead, loaders)).toBe(true);
    expect(await canEditEntry(member("lead-a"), sharedByCap, loaders)).toBe(false);
    expect(await canEditEntry(member("member-a"), noteByCap, loaders)).toBe(false);
  });

  it("the assigned Captain reads shared entries, edits their own, and holds their own sensitive notes only", async () => {
    await grant("cap");
    await grant("cap2");
    const loaders = assigned("cap", PROJECT_A);
    const cap = member("cap");
    expect(await entryAudience(sharedByLead, cap, loaders)).toBe("read");
    expect(await entryAudience(sharedByCap, cap, loaders)).toBe("read_write");
    expect(await entryAudience(noteByCap, cap, loaders)).toBe("read_write");
    expect(await entryAudience(noteByCap2, cap, loaders)).toBe("none");
    expect(await canEditEntry(cap, sharedByCap, loaders)).toBe(true);
    expect(await canEditEntry(cap, noteByCap, loaders)).toBe(true);
    expect(await canEditEntry(cap, sharedByLead, loaders)).toBe(false);
    expect(await canEditEntry(cap, noteByCap2, loaders)).toBe(false);
  });

  it("another Captain has no access through the role, except a read-only view of their own sensitive note", async () => {
    await grant("cap");
    await grant("cap2");
    const loaders = assigned("cap", PROJECT_A);
    const other = member("cap2");
    expect(await entryAudience(sharedByLead, other, loaders)).toBe("none");
    expect(await entryAudience(sharedByCap, other, loaders)).toBe("none");
    expect(await entryAudience(noteByCap, other, loaders)).toBe("none");
    expect(await entryAudience(noteByCap2, other, loaders)).toBe("read");
    expect(await canEditEntry(other, noteByCap2, loaders)).toBe(false);
  });

  it("a reassigned Captain keeps a read-only view of their own notes while the capability lasts, and nothing after revocation", async () => {
    await grant("cap");
    const reassigned = assigned("cap2", PROJECT_A);
    const cap = member("cap");
    expect(await entryAudience(noteByCap, cap, reassigned)).toBe("read");
    expect(await canEditEntry(cap, noteByCap, reassigned)).toBe(false);
    expect(await entryAudience(sharedByCap, cap, reassigned)).toBe("none");
    expect(await entryAudience(sharedByLead, cap, reassigned)).toBe("none");
    await revoke("cap");
    expect(await entryAudience(noteByCap, cap, reassigned)).toBe("none");
    expect(await entryAudience(noteByCap, cap, assigned("cap", PROJECT_A))).toBe("none");
  });

  it("an unrelated member, a job, and an entry under the wrong edition get nothing", async () => {
    await grant("cap");
    for (const item of all) {
      expect(await entryAudience(item, member("plain"), assigned("cap", PROJECT_A))).toBe("none");
      expect(await entryAudience(item, JOB)).toBe("none");
      expect(await canEditEntry(JOB, item)).toBe(false);
    }
    const misfiled = entry("lead-a", "shared", PROJECT_A, EDITION_B);
    expect(await entryAudience(misfiled, member("lead-a"))).toBe("none");
    expect(await entryAudience(entry("lead-a", "shared", UNKNOWN), member("lead-a"))).toBe("none");
  });
});

describe("assertHackathonMatches", () => {
  it("returns the record under its own edition and stops otherwise, the same way for a missing record", () => {
    const record = { id: "x", hackathonId: EDITION_A };
    expect(assertHackathonMatches(record, EDITION_A)).toBe(record);
    expect(() => assertHackathonMatches(record, EDITION_B)).toThrow(BuilderError);
    let mismatch = "";
    let missing = "";
    try { assertHackathonMatches(record, EDITION_B); } catch (error) { mismatch = (error as Error).message; }
    try { assertHackathonMatches(null, EDITION_A); } catch (error) { missing = (error as Error).message; }
    expect(mismatch).toBe(missing);
    expect(mismatch).not.toBe("");
    expect(() => assertHackathonMatches(undefined, EDITION_A)).toThrow(BuilderError);
  });
});

describe("assignCaptain feeding real rows into authorizeProjectAction (task T4.4)", () => {
  // Phase 1's fixture tests above inject loadCurrentAssignment; this is the
  // one integration test that runs the same decision logic over a real
  // hq_captain_assignments row assignCaptain/unassignCaptain (lib/hq/captains.ts)
  // actually write, not a re-run of those fixture cases.
  it("after assignment the Captain gets CAPTAIN_ACTIONS but not membership.change; after unassignment the next call denies everything", async () => {
    await grant("cap2");
    const actor = member("cap2", ["captain"]);
    // Holds the capability, assigned to nothing yet: not_assigned, not not_found.
    expect(await authorizeProjectAction(actor, { projectId: PROJECT_C, hackathonId: EDITION_B, action: "read" })).toEqual({ allowed: false, reason: "not_assigned" });

    const assigned = await assignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId: PROJECT_C, hackathonId: EDITION_B, captainUserId: "cap2" });
    expect(assigned.outcome).toBe("assigned");

    for (const action of ["read", "update.create", "update.edit", "assignment.read"] as const) {
      expect(await authorizeProjectAction(actor, { projectId: PROJECT_C, hackathonId: EDITION_B, action })).toEqual({ allowed: true, via: "captain" });
    }
    expect(await authorizeProjectAction(actor, { projectId: PROJECT_C, hackathonId: EDITION_B, action: "membership.change" })).toEqual({ allowed: false, reason: "not_member" });

    const unassigned = await unassignCaptain(db, { actorOperatorId: OPERATOR_ID, projectId: PROJECT_C, hackathonId: EDITION_B });
    expect(unassigned.outcome).toBe("unassigned");

    for (const action of ACTIONS) {
      expect(await authorizeProjectAction(actor, { projectId: PROJECT_C, hackathonId: EDITION_B, action })).toEqual({ allowed: false, reason: "not_assigned" });
    }
  });
});

describe("the actor", () => {
  const OPERATOR_USER = { id: OPERATOR_ID, username: "operator", displayName: "Operator", mustChangePassword: false };
  const MEMBER_USER = { id: "cap", email: null, name: "Captain" };
  const redirect = (path: string) => { throw new Error(`REDIRECT:${path}`); };

  it("resolves the operator session first when both sessions are present, without consulting the member session", async () => {
    mocks.currentUser.mockResolvedValue(OPERATOR_USER);
    mocks.currentMember.mockResolvedValue(MEMBER_USER);
    expect(await currentActor()).toEqual({ kind: "operator", id: OPERATOR_ID, displayName: "Operator" });
    expect(mocks.currentMember).not.toHaveBeenCalled();
  });

  it("builds the member actor from the member session with current grants and the Telegram identity as a string", async () => {
    await grant("cap");
    await rows(`INSERT INTO hq_auth_user(id,name,email,"emailVerified") VALUES('cap','Captain','cap@telegram.placeholder.invalid',false)`);
    await rows("INSERT INTO hq_auth_telegram_identity(user_id,provider_subject,telegram_user_id,username) VALUES('cap','cap-subject',9007199254740993,'cap_handle')");
    mocks.currentUser.mockResolvedValue(null);
    mocks.currentMember.mockResolvedValue(MEMBER_USER);
    expect(await currentActor()).toEqual({
      kind: "member", id: "cap", name: "Captain", email: null, capabilities: new Set(["captain"]), telegram: { userId: "9007199254740993" },
    });
    await revoke("cap");
    const later = await currentActor();
    expect(later?.kind === "member" && later.capabilities).toEqual(new Set());
    mocks.currentMember.mockResolvedValue({ id: "plain", email: "plain@example.test", name: "Plain" });
    expect(await currentActor()).toEqual({ kind: "member", id: "plain", name: "Plain", email: "plain@example.test", capabilities: new Set(), telegram: null });
  });

  it("is null without a session, and an operator who must change their password is not an operator actor", async () => {
    mocks.currentUser.mockResolvedValue(null);
    mocks.currentMember.mockResolvedValue(null);
    expect(await currentActor()).toBeNull();
    mocks.currentUser.mockResolvedValue({ ...OPERATOR_USER, mustChangePassword: true });
    expect(await currentActor()).toBeNull();
    mocks.currentMember.mockResolvedValue({ id: "plain", email: "plain@example.test", name: "Plain" });
    expect((await currentActor())?.kind).toBe("member");
  });

  it("requireOperatorActor and requireOperator wrap requireUser and never admit a member session", async () => {
    mocks.requireUser.mockResolvedValue(OPERATOR_USER);
    expect(await requireOperatorActor()).toEqual({ kind: "operator", id: OPERATOR_ID, displayName: "Operator" });
    expect(await requireOperator()).toEqual({ kind: "operator", id: OPERATOR_ID, displayName: "Operator" });
    mocks.requireUser.mockImplementation(async () => redirect("/hq/login"));
    mocks.currentMember.mockResolvedValue(MEMBER_USER);
    mocks.requireMember.mockResolvedValue(MEMBER_USER);
    await expect(requireOperatorActor()).rejects.toThrow("REDIRECT:/hq/login");
    await expect(requireOperator()).rejects.toThrow("REDIRECT:/hq/login");
    expect(mocks.currentMember).not.toHaveBeenCalled();
    expect(mocks.requireMember).not.toHaveBeenCalled();
  });

  it("requireMemberActor redirects like requireMember and passes the destination through", async () => {
    mocks.requireMember.mockImplementation(async (next?: string) => redirect(`/hq/signin?next=${encodeURIComponent(next ?? "/hq/welcome")}`));
    await expect(requireMemberActor("/hq/team/x")).rejects.toThrow("REDIRECT:/hq/signin?next=%2Fhq%2Fteam%2Fx");
    mocks.requireMember.mockResolvedValue(MEMBER_USER);
    expect(await requireMemberActor()).toEqual({ kind: "member", id: "cap", name: "Captain", email: null, capabilities: new Set(), telegram: null });
    expect(mocks.requireUser).not.toHaveBeenCalled();
  });

  it("takes no identity from a request: no form, body, query or cookie read anywhere in the actor or authorization modules", () => {
    for (const file of ["lib/hq/actor.ts", "lib/hq/authz.ts", "lib/hq/authz-sql.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/formData|FormData|searchParams|cookies\(|headers\(|next\/headers/);
    }
    expect(currentActor.length).toBe(0);
    expect(requireOperatorActor.length).toBe(0);
    expect(requireOperator.length).toBe(0);
  });
});
