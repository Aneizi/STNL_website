import "server-only";
import type { Actor } from "../actor";
import type { AuditActor } from "../audit";
import type { ReportingEligibility, ReportingPeriod } from "../reporting-enrolment";

/** Jobs have no user id and audit as system actors. */
export const auditActor = (actor: Actor): AuditActor =>
  actor.kind === "job" ? { kind: "system", id: null } : { kind: actor.kind, id: actor.id };

/** Reject malformed IDs before they reach PostgreSQL's UUID cast. */
const UUID_ARG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuidArg = (value: unknown): value is string => typeof value === "string" && UUID_ARG.test(value);

/** Historical pause intervals determine accountability; resuming cannot create missed weeks. */
export const accountable = (eligibility: ReportingEligibility, period: ReportingPeriod) => {
  if (Date.parse(eligibility.eligibleFrom) >= Date.parse(period.endsAt)) return false;
  const ends = Date.parse(period.endsAt);
  return !eligibility.pauses.some(
    (pause) => Date.parse(pause.pausedAt) < ends && (pause.resumedAt == null || Date.parse(pause.resumedAt) >= ends),
  );
};

/** Normalize the stored outcome basis for both live status and closed outcomes. */
export const toBasis = (value: unknown): "entry" | "submission" | "none" => (value === "entry" || value === "submission" ? value : "none");
