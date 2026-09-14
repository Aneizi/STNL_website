// Capability grants and the append-only audit trail, against the real schema
// on PGlite: idempotent grant and revoke, one effective grant per capability,
// the acting actor and the attributed operator recorded separately, grant and
// event committing or rolling back together, and an audit module that cannot
// update or delete.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ builderDatabase: vi.fn() }));
vi.mock("@/lib/hq/builder-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hq/builder-db")>()),
  builderDatabase: mocks.builderDatabase,
}));

import * as audit from "@/lib/hq/audit";
import * as auditSql from "@/lib/hq/audit-sql";
import { AUDIT_EVENT_KINDS } from "@/lib/hq/audit-sql";
import type { BuilderDatabase } from "@/lib/hq/builder-db";
import {
  grantCapability, listActiveCapabilities, listActiveCapabilitiesForUsers, listCapabilityGrants, personTags, revokeCapability,
} from "@/lib/hq/capabilities";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const OPERATOR = "00000000-0000-4000-8000-000000000001";
const SECOND_OPERATOR = "00000000-0000-4000-8000-000000000002";
let pg: PGlite;
let db: BuilderDatabase;

/** The Admin case: the operator is both the acting actor and the row's granted_by / revoked_by. */
const byOperator = (id: string) => ({ actor: { kind: "operator" as const, id }, byOperatorId: id });

async function rows(text: string, values: unknown[] = []) { return (await pg.query(text, values)).rows as Record<string, unknown>[]; }
const grantRows = () => rows("SELECT user_id,capability,granted_by_user_id::text AS granted_by,revoked_by_user_id::text AS revoked_by,revoked_at IS NULL AS active,reason FROM hq_account_capabilities ORDER BY granted_at,id");
const events = () => rows("SELECT kind,actor_kind,actor_id,subject_user_id,metadata FROM hq_audit_events ORDER BY id");

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  mocks.builderDatabase.mockReturnValue(db);
}, 30_000);

beforeEach(async () => {
  await pg.exec("TRUNCATE hq_users, hq_builder_profiles, hq_audit_events RESTART IDENTITY CASCADE");
  await rows("INSERT INTO hq_users(id,username,display_name,password_hash) VALUES($1,'operator','Operator','unused'),($2,'second','Second','unused')", [OPERATOR, SECOND_OPERATOR]);
  await rows("INSERT INTO hq_builder_profiles(id,email,name) VALUES('acct-a','a@example.test','Account A'),('acct-b',NULL,'Account B')");
});

afterAll(async () => { await pg.close(); });

describe("grantCapability and revokeCapability", () => {
  it("grants once, records the operator and the reason, and is visible on the next read", async () => {
    const grant = await grantCapability(db, { ...byOperator(OPERATOR), userId: "acct-a", capability: "captain", reason: "Leads the Utrecht cohort" });
    expect(grant).toMatchObject({ userId: "acct-a", userName: "Account A", capability: "captain", grantedByUserId: OPERATOR, revokedAt: null, revokedByUserId: null, reason: "Leads the Utrecht cohort" });
    expect(await grantRows()).toEqual([{ user_id: "acct-a", capability: "captain", granted_by: OPERATOR, revoked_by: null, active: true, reason: "Leads the Utrecht cohort" }]);
    expect(await events()).toEqual([
      { kind: "capability.granted", actor_kind: "operator", actor_id: OPERATOR, subject_user_id: "acct-a", metadata: { capability: "captain", grantId: grant.id, reason: "Leads the Utrecht cohort" } },
    ]);
    expect(await listActiveCapabilities("acct-a")).toEqual(["captain"]);
    expect(await listActiveCapabilities("acct-b")).toEqual([]);
  });

  it("returns the existing grant on a repeat and writes no second row or event", async () => {
    const first = await grantCapability(db, { ...byOperator(OPERATOR), userId: "acct-a", capability: "captain", reason: "first" });
    const again = await grantCapability(db, { ...byOperator(SECOND_OPERATOR), userId: "acct-a", capability: "captain", reason: "second" });
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ grantedByUserId: OPERATOR, reason: "first" });
    expect(await grantRows()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it("revokes once, keeps the row as history, and lets a later grant start a new row", async () => {
    const grant = await grantCapability(db, { ...byOperator(OPERATOR), userId: "acct-a", capability: "captain", reason: "start" });
    const revoked = await revokeCapability(db, { ...byOperator(SECOND_OPERATOR), userId: "acct-a", capability: "captain", reason: "moved on" });
    expect(revoked).toMatchObject({ id: grant.id, revokedByUserId: SECOND_OPERATOR, reason: "start" });
    expect(revoked?.revokedAt).not.toBeNull();
    expect(await listActiveCapabilities("acct-a")).toEqual([]);
    // Idempotent: nothing active, nothing written.
    expect(await revokeCapability(db, { ...byOperator(OPERATOR), userId: "acct-a", capability: "captain", reason: "again" })).toBeNull();
    expect(await events()).toEqual([
      expect.objectContaining({ kind: "capability.granted" }),
      { kind: "capability.revoked", actor_kind: "operator", actor_id: SECOND_OPERATOR, subject_user_id: "acct-a", metadata: { capability: "captain", grantId: grant.id, reason: "moved on" } },
    ]);
    const regrant = await grantCapability(db, { ...byOperator(OPERATOR), userId: "acct-a", capability: "captain", reason: "back" });
    expect(regrant.id).not.toBe(grant.id);
    expect(await grantRows()).toEqual([
      expect.objectContaining({ active: false, reason: "start", revoked_by: SECOND_OPERATOR }),
      expect.objectContaining({ active: true, reason: "back", revoked_by: null }),
    ]);
    expect(await listCapabilityGrants({ capability: "captain" })).toEqual([
      expect.objectContaining({ id: regrant.id, userName: "Account A", revokedAt: null }),
      expect.objectContaining({ id: grant.id, revokedByUserId: SECOND_OPERATOR }),
    ]);
    expect((await listCapabilityGrants({ capability: "captain", activeOnly: true })).map((g) => g.id)).toEqual([regrant.id]);
  });

  it("records the acting member or job on the event and keeps the row's operator attribution separate", async () => {
    // Phase 4's invitation redemption: the member accepts, so the trail must
    // say member; the operator who created the invitation is only granted_by.
    const grant = await grantCapability(db, {
      actor: { kind: "member", id: "acct-a" }, byOperatorId: OPERATOR, userId: "acct-a", capability: "captain", reason: "Accepted a Captain invitation",
    });
    expect(grant.grantedByUserId).toBe(OPERATOR);
    expect(await events()).toEqual([
      { kind: "capability.granted", actor_kind: "member", actor_id: "acct-a", subject_user_id: "acct-a", metadata: { capability: "captain", grantId: grant.id, reason: "Accepted a Captain invitation" } },
    ]);

    // And with no operator behind it at all, the row's granted_by is null.
    const revoked = await revokeCapability(db, { actor: { kind: "member", id: "acct-a" }, byOperatorId: null, userId: "acct-a", capability: "captain", reason: "Stepped down" });
    expect(revoked).toMatchObject({ id: grant.id, revokedByUserId: null });
    const second = await grantCapability(db, { actor: { kind: "system", id: null }, byOperatorId: null, userId: "acct-b", capability: "captain", reason: "Restored by a job" });
    expect(second.grantedByUserId).toBeNull();
    expect((await events()).slice(1)).toEqual([
      expect.objectContaining({ kind: "capability.revoked", actor_kind: "member", actor_id: "acct-a" }),
      expect.objectContaining({ kind: "capability.granted", actor_kind: "system", actor_id: null, subject_user_id: "acct-b" }),
    ]);
  });

  it("allows one effective grant per capability at the database level", async () => {
    await grantCapability(db, { ...byOperator(OPERATOR), userId: "acct-a", capability: "captain", reason: "x" });
    await expect(rows("INSERT INTO hq_account_capabilities(user_id,capability) VALUES('acct-a','captain')")).rejects.toThrow(/hq_account_capabilities_active_idx/);
    await expect(rows("INSERT INTO hq_account_capabilities(user_id,capability) VALUES('acct-a','mayor')")).rejects.toThrow(/check/i);
  });

  it("rolls the grant back when the audit event cannot be written", async () => {
    await rows("ALTER TABLE hq_audit_events ADD CONSTRAINT test_audit_failure CHECK (kind <> 'capability.granted')");
    try {
      await expect(grantCapability(db, { ...byOperator(OPERATOR), userId: "acct-a", capability: "captain", reason: "x" })).rejects.toThrow(/test_audit_failure/);
    } finally { await rows("ALTER TABLE hq_audit_events DROP CONSTRAINT test_audit_failure"); }
    expect(await grantRows()).toEqual([]);
    expect(await events()).toEqual([]);
    expect(await listActiveCapabilities("acct-a")).toEqual([]);
    // And the same for a revocation.
    await grantCapability(db, { ...byOperator(OPERATOR), userId: "acct-a", capability: "captain", reason: "x" });
    await rows("ALTER TABLE hq_audit_events ADD CONSTRAINT test_audit_failure CHECK (kind <> 'capability.revoked')");
    try {
      await expect(revokeCapability(db, { ...byOperator(OPERATOR), userId: "acct-a", capability: "captain", reason: "y" })).rejects.toThrow(/test_audit_failure/);
    } finally { await rows("ALTER TABLE hq_audit_events DROP CONSTRAINT test_audit_failure"); }
    expect(await listActiveCapabilities("acct-a")).toEqual(["captain"]);
    expect(await events()).toHaveLength(1);
  });

  it("refuses an unknown account or capability without writing anything", async () => {
    await expect(grantCapability(db, { ...byOperator(OPERATOR), userId: "nobody", capability: "captain", reason: "x" })).rejects.toThrow("account");
    await expect(grantCapability(db, { ...byOperator(OPERATOR), userId: "acct-a", capability: "mayor" as "captain", reason: "x" })).rejects.toThrow("capability");
    expect(await grantRows()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("joins the caller's transaction, so a failing later statement takes the grant with it", async () => {
    await expect(db.transaction(async (tx) => {
      await grantCapability(tx, { ...byOperator(OPERATOR), userId: "acct-a", capability: "captain", reason: "x" });
      await tx.query("INSERT INTO hq_builder_profiles(id,name) VALUES('acct-a','duplicate')");
    })).rejects.toThrow();
    expect(await grantRows()).toEqual([]);
    expect(await events()).toEqual([]);
  });
});

describe("reading capabilities", () => {
  it("answers for every requested account in one query and skips the query for none", async () => {
    await grantCapability(db, { ...byOperator(OPERATOR), userId: "acct-b", capability: "captain", reason: "x" });
    const queries: string[] = [];
    const counting = { query: (text: string, values?: unknown[]) => { queries.push(text); return db.query(text, values); } };
    const byUser = await listActiveCapabilitiesForUsers(["acct-a", "acct-b", "acct-a", "ghost"], counting);
    expect([...byUser.entries()]).toEqual([["acct-a", []], ["acct-b", ["captain"]], ["ghost", []]]);
    expect(queries).toHaveLength(1);
    expect(await listActiveCapabilitiesForUsers([], counting)).toEqual(new Map());
    expect(queries).toHaveLength(1);
  });

  it("renders the role tag first and one locked tag per capability", () => {
    expect(personTags("Builder", [])).toEqual([{ kind: "role", label: "Builder", protected: false }]);
    expect(personTags("Partner captain", ["captain"])).toEqual([
      { kind: "role", label: "Partner captain", protected: false },
      { kind: "capability", label: "Captain", protected: true },
    ]);
  });
});

describe("the audit module", () => {
  it("exposes insert and read only, and no update or delete anywhere", () => {
    expect(Object.keys(audit).sort()).toEqual(["listAuditEvents", "recordAuditEvent"]);
    expect(Object.keys(auditSql).sort()).toEqual(["AUDIT_EVENT_KINDS", "AUDIT_SELECT", "insertAuditEventStatement", "listAuditEventsStatement", "toAuditEvent"]);
    for (const name of [...Object.keys(audit), ...Object.keys(auditSql)]) {
      expect(name).not.toMatch(/update|delete|remove|purge|patch|edit|clear/i);
    }
    const insert = auditSql.insertAuditEventStatement({ kind: "identity.linked", actor: { kind: "system", id: null } });
    const list = auditSql.listAuditEventsStatement({}, { limit: 10 });
    expect(insert.text).not.toMatch(/\b(UPDATE|DELETE)\b/i);
    expect(list.text).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
    expect(AUDIT_EVENT_KINDS).toEqual([
      "capability.granted", "capability.revoked", "identity.linked", "identity.unlinked", "identity.email_changed",
      "bot.consent_changed", "person.linked", "person.match_corrected", "captain.assigned", "captain.unassigned",
      "captain.invitation_created", "captain.invitation_revoked", "captain.invitation_redeemed",
      "project.imported", "project.deleted", "person.deleted",
    ]);
  });

  it("lists events newest first, filtered and keyset paged, with metadata round-tripping", async () => {
    await rows("INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES(7,'edition','Edition','2026-09-14','2026-10-12')");
    const project = "00000000-0000-4000-8000-00000000aaaa";
    const first = await audit.recordAuditEvent(db, { kind: "identity.linked", actor: { kind: "member", id: "acct-a" }, subjectUserId: "acct-a", metadata: { provider: "telegram" } });
    const second = await audit.recordAuditEvent(db, { kind: "captain.assigned", actor: { kind: "operator", id: OPERATOR }, subjectUserId: "acct-a", hackathonId: 7, projectId: project, metadata: { count: 2 } });
    const third = await audit.recordAuditEvent(db, { kind: "identity.linked", actor: { kind: "system", id: null }, subjectUserId: "acct-b" });
    expect(first).toMatchObject({ kind: "identity.linked", actor: { kind: "member", id: "acct-a" }, subjectUserId: "acct-a", hackathonId: null, projectId: null, metadata: { provider: "telegram" } });
    expect(second).toMatchObject({ hackathonId: 7, projectId: project, metadata: { count: 2 } });
    expect(third).toMatchObject({ actor: { kind: "system", id: null }, metadata: {} });
    expect(Number(third.id)).toBeGreaterThan(Number(first.id));

    const page = await audit.listAuditEvents({}, { limit: 2 });
    expect(page.events.map((e) => e.id)).toEqual([third.id, second.id]);
    expect(page.nextCursor).toBe(second.id);
    const rest = await audit.listAuditEvents({}, { limit: 2, cursor: page.nextCursor });
    expect(rest.events.map((e) => e.id)).toEqual([first.id]);
    expect(rest.nextCursor).toBeNull();
    expect((await audit.listAuditEvents({ subjectUserId: "acct-a", kind: "identity.linked" }, { limit: 10 })).events.map((e) => e.id)).toEqual([first.id]);
    expect((await audit.listAuditEvents({ hackathonId: 7 }, { limit: 10 })).events.map((e) => e.id)).toEqual([second.id]);
    expect((await audit.listAuditEvents({ projectId: project }, { limit: 10 })).events.map((e) => e.id)).toEqual([second.id]);
    // Deleting the edition keeps the event; the reference is cleared.
    await rows("DELETE FROM hq_hackathons WHERE id=7");
    expect((await audit.listAuditEvents({ kind: "captain.assigned" }, { limit: 10 })).events[0]).toMatchObject({ id: second.id, hackathonId: null });
  });

  it("refuses a note body sized payload only by convention: metadata stays structural", () => {
    // The contract is documented, not enforced by the database. This pins the
    // documented shape so a later change to metadata is a visible decision.
    const statement = auditSql.insertAuditEventStatement({ kind: "capability.granted", actor: { kind: "operator", id: OPERATOR }, subjectUserId: "acct-a", metadata: { capability: "captain", grantId: "1", reason: "short reason" } });
    expect(JSON.parse(String(statement.values[6]))).toEqual({ capability: "captain", grantId: "1", reason: "short reason" });
  });
});
