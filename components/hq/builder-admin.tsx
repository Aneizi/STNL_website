"use client";

import { useRef, useState, useSyncExternalStore, useTransition, type FormEvent, type ReactNode } from "react";
import {
  attachColosseumProject, createProjectFromImportRequest,
  deleteBuilderTeam, markBuilderProjectPotential, resolveBuilderImportRequest,
  updateBuilderOnboardingConfig, updateBuilderProjectLead,
} from "@/lib/hq/actions/builders-admin";
import { createCaptainInvitation, revokeCaptainInvitation } from "@/lib/hq/actions/captains";
import type {
  AccountLogin, AdminCaptainLeaderboardRow, BuilderImportRequest, BuilderProjectReview, OnboardingConfig,
} from "@/lib/hq/builder-admin-queries";
import type { CaptainInvitationListing } from "@/lib/hq/captains";
import { SUBMISSION_LABELS } from "@/lib/hq/colosseum-snapshot";
import { fmtWithZone } from "@/lib/hq/format";
import { inviteLink } from "@/lib/hq/member-routes";
import type { ActionResult } from "@/lib/hq/types";
import { BuilderProjectImage } from "./builder-project-image";
import { CopyButton } from "./ui-client";
import styles from "./builder-admin.module.css";

/**
 * How an account signs in, as Admin shows it: the verified login email, or
 * the Telegram handle for a Telegram-only account. The placeholder address
 * is never in the data, so it is never shown.
 */
export function loginLabel({ email, telegram }: AccountLogin): string {
  if (email) return email;
  if (telegram) return telegram.username ? `Telegram: @${telegram.username}` : "Telegram account";
  return "No login email";
}

// This form's outcome message is local state, as is the open state of the
// <details> around it, so every row below is keyed by its record id alone. A
// key that also carried the state the row's own form changes (a grant, a
// verification) remounted the row on the very save that changed it, closing
// the <details> and taking the "Saved." line with it.
//
// Because the row no longer remounts, a control whose summary/button flips
// its own label after a save (Grant Captain -> Revoke Captain, Review ->
// Change verification) must reset on success: without it, the just-typed
// reason and a pre-checked "required" confirm box would sit behind the new
// label, so one further stray click could revoke or re-decide with a stale
// confirmation. `resetOnSuccess` opts a form into that — form.reset() clears
// every input back to its defaultValue, which is exactly what a fresh
// instance of the same control should show next. It defaults to false: a
// form whose fields take their `defaultValue` from server props (onboarding
// settings, a tier select, a project lead select) must NOT reset on its own
// success, or the admin would briefly see the pre-save value snap back next
// to "Saved.", before the revalidatePath round trip replaces it with the
// real one.
function ActionForm({ action, children, resetOnSuccess = false }: { action: (data: FormData) => Promise<ActionResult>; children: ReactNode; resetOnSuccess?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form, (event.nativeEvent as SubmitEvent).submitter);
    setMessage("");
    setError(false);
    startTransition(async () => {
      try {
        const result = await action(data);
        setError(!result.ok);
        setMessage(result.ok ? "Saved." : result.error ?? "Could not save. Try again.");
        if (result.ok && resetOnSuccess) form.reset();
      } catch {
        setError(true);
        setMessage("Could not save. Try again.");
      }
    });
  }
  return (
    <form onSubmit={submit} aria-busy={pending}>
      <fieldset disabled={pending} className={styles.fieldset}>{children}</fieldset>
      {(pending || message) && <div className={`${styles.feedback} ${error ? styles.error : ""}`} role={error ? "alert" : "status"}>{pending ? "Saving…" : message}</div>}
    </form>
  );
}

function localDateTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  // The field is explicitly UTC, so rendering is identical on the server and client.
  return date.toISOString().slice(0, 16);
}

function projectHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "colosseum.com" && url.pathname.startsWith("/arena/projects/") && !url.username && !url.password) return url.href;
  } catch { /* Show malformed imported URLs as plain text. */ }
  return undefined;
}

export function BuilderAdmin({ config, captainInvitations, captainLeaderboard, timezone }: {
  config: OnboardingConfig; captainInvitations: CaptainInvitationListing[]; captainLeaderboard: AdminCaptainLeaderboardRow[]; timezone: string;
}) {
  return (
    <>
      <section className={styles.section} aria-labelledby="builder-onboarding-title">
        <h2 id="builder-onboarding-title">Builder onboarding</h2>
        <ActionForm action={(data) => updateBuilderOnboardingConfig({
          externalHackathonId: String(data.get("externalId") ?? "").trim() ? Number(data.get("externalId")) : null,
          externalHackathonSlug: String(data.get("externalSlug") ?? ""),
          projectsOpen: data.has("projectsOpen"),
          projectsAvailableAt: data.get("availableAt") ? new Date(`${data.get("availableAt")}:00Z`).toISOString() : "",
          signupUrl: String(data.get("signupUrl") ?? ""),
        })}>
          <div className={styles.grid}>
            <label className={styles.field}>Hackathon ID<input name="externalId" inputMode="numeric" pattern="[0-9]+" defaultValue={config.externalHackathonId ?? ""} /></label>
            <label className={styles.field}>Slug<input name="externalSlug" defaultValue={config.externalHackathonSlug} maxLength={200} spellCheck={false} /></label>
            <label className={styles.field}>Project access date (UTC)<input name="availableAt" type="datetime-local" defaultValue={localDateTime(config.projectsAvailableAt)} /></label>
            <label className={styles.field}>Signup URL<input name="signupUrl" type="url" defaultValue={config.signupUrl} required /></label>
          </div>
          <label className={styles.checkbox}>Enable project imports<input name="projectsOpen" type="checkbox" defaultChecked={config.projectsOpen} /></label>
          <div className={styles.actions}><button className={styles.button} type="submit">Save</button></div>
        </ActionForm>
      </section>
      <CaptainInvitations invitations={captainInvitations} timezone={timezone} />
      <CaptainLeaderboard rows={captainLeaderboard} />
    </>
  );
}

const INVITATION_STATE_LABELS: Record<CaptainInvitationListing["state"], string> = {
  active: "Active", expired: "Expired", revoked: "Revoked", full: "Full",
};

/**
 * The moment this form hydrated on the client, or null on the server and on
 * the client's own first (hydrating) render. Date.now() is impure: calling
 * it directly in a component body is against the rules of React (it would
 * also disagree with the server's render, a hydration mismatch), so the one
 * read lives inside useSyncExternalStore's getSnapshot, its documented seam
 * for reading an external, non-React value, cached in a ref so repeated
 * calls agree with themselves instead of drifting with the clock. No
 * subscription is needed since this never changes again after mount, hence
 * the no-op subscribe.
 */
function useClientNow(): number | null {
  const cached = useRef<number | null>(null);
  return useSyncExternalStore(
    () => () => {},
    () => (cached.current ??= Date.now()),
    () => null,
  );
}

/**
 * Days from now, formatted with its zone, for the create form's expiry
 * preview. Null on the server and on the client's first render (see
 * useClientNow), so the first client render still matches the server's,
 * the same hydration problem localDateTime above solves a different way, by
 * only ever formatting a fixed UTC value instead of "now".
 */
function useExpiryPreview(days: number, timezone: string): string {
  const now = useClientNow();
  if (now == null || !Number.isFinite(days) || days <= 0) return "";
  return fmtWithZone(new Date(now + days * 86_400_000).toISOString(), timezone);
}

/**
 * Captain invitation links: admin-generated links that grant the Captain
 * capability only, never operator access and never a project assignment.
 *
 * The create form is not an ActionForm: createCaptainInvitation returns a
 * distinct { token, invitation } shape (never ActionResult) so the plaintext
 * link can be returned once, and ActionForm's contract is ActionResult only.
 * The one-time link is kept in its own `created` state instead of the form's
 * fields, so resetting the form on success (clearing label / limit / days
 * for the next invitation) never touches the link still on screen.
 */
function CaptainInvitations({ invitations, timezone }: { invitations: CaptainInvitationListing[]; timezone: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ token: string } | null>(null);
  const [days, setDays] = useState(7);
  const preview = useExpiryPreview(days, timezone);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError("");
    startTransition(async () => {
      try {
        const result = await createCaptainInvitation({
          label: String(data.get("label") ?? "").trim() || undefined,
          maxRedemptions: Number(data.get("maxRedemptions")),
          expiresInDays: Number(data.get("validForDays")),
        });
        if (!result.ok) { setError(result.error); return; }
        setCreated({ token: result.token });
        form.reset();
        setDays(7);
      } catch {
        // requireUser() throws on an expired or lost operator session, the
        // most likely failure on a long-open Admin tab, and the action
        // rethrows anything that is not a BuilderError.
        setError("Could not create the invitation. Try again.");
      }
    });
  }

  const link = created ? `${window.location.origin}${inviteLink(created.token)}` : "";

  return (
    <section className={styles.section} aria-labelledby="captain-invitations-title">
      <h2 id="captain-invitations-title">Captain invitation links</h2>
      <form onSubmit={submit} aria-busy={pending}>
        <fieldset disabled={pending} className={styles.fieldset}>
          <div className={styles.grid}>
            <label className={styles.field}>Label<input name="label" maxLength={200} placeholder="e.g. Rotterdam meetup" /></label>
            <label className={styles.field}>Max accounts<input name="maxRedemptions" type="number" inputMode="numeric" min={1} max={500} defaultValue={1} required /></label>
            <label className={styles.field}>Valid for (days)<input name="validForDays" type="number" inputMode="numeric" min={1} max={365} defaultValue={7} required onChange={(event) => setDays(Number(event.currentTarget.value))} /></label>
          </div>
          <div className={`${styles.actions} ${styles.actionsWide}`}>
            <button className={styles.button} type="submit">Create link</button>
            <span className={styles.hint}>{preview ? `Expires ${preview}` : "Choose a duration to see the expiry."}</span>
          </div>
        </fieldset>
        {(pending || error) && <div className={`${styles.feedback} ${error ? styles.error : ""}`} role={error ? "alert" : "status"}>{pending ? "Creating…" : error}</div>}
      </form>
      {created && (
        <div className={styles.block} role="status">
          <p className={styles.lead}>Copy now. This link is not shown again.</p>
          <div className={styles.linkRow}>
            <span className={styles.link}>{link}</span>
            <CopyButton value={link} />
          </div>
        </div>
      )}
      {invitations.map((invitation) => (
        <article className={styles.block} key={invitation.id}>
          <div className={styles.blockHeader}>
            <h3>{invitation.label || "Untitled invitation"}</h3>
            <span className={styles.pill}>{INVITATION_STATE_LABELS[invitation.state]}</span>
          </div>
          <p>
            {invitation.usedCount} of {invitation.maxRedemptions} used. Expires {fmtWithZone(invitation.expiresAt, timezone)}.
            {" "}By {invitation.createdByName ?? "a since-removed operator"}, {invitation.createdAt.slice(0, 10)}
          </p>
          {invitation.redeemers.length > 0 && (
            <ul className={styles.redeemers} aria-label={`${invitation.label || "Untitled invitation"} redeemers`}>
              {invitation.redeemers.map((redeemer, index) => (
                <li key={redeemer.userId ?? `deleted-${index}`}>
                  <span>{redeemer.name ?? "Deleted account"}</span>
                  <span className={styles.date}>{redeemer.redeemedAt.slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          )}
          {invitation.state !== "revoked" && (
            <ActionForm action={() => revokeCaptainInvitation(invitation.id)}>
              <div className={styles.actions}><button className={styles.secondary} type="submit">Revoke</button></div>
            </ActionForm>
          )}
        </article>
      ))}
    </section>
  );
}

/**
 * The Captain leaderboard, edition-scoped: ranked rows with the bar scaled
 * to the top count, the project names under each name. `rows` is the
 * admin-only shape getBuilderAdminData builds server-side, keyed by account
 * id rather than by a display name two Captains may share.
 */
function CaptainLeaderboard({ rows }: { rows: AdminCaptainLeaderboardRow[] }) {
  const top = Math.max(1, rows[0]?.assignedCount ?? 0);
  return (
    <section className={styles.section} aria-labelledby="captain-leaderboard-title">
      <div className={styles.header}>
        <h2 id="captain-leaderboard-title">Captain leaderboard</h2>
        <span className={styles.headerNote}>Active projects held</span>
      </div>
      <ol className={styles.leaderboard} aria-label="Captain leaderboard">
        {rows.map((row) => (
          <li key={row.captainUserId}>
            <span className={styles.rank}>{row.rank}</span>
            <span className={styles.captain}>
              <span className={styles.captainName}>{row.displayName}</span>
              <span className={styles.projects}>{row.projectNames.join(", ") || "No projects yet"}</span>
            </span>
            <span className={styles.bar}><span className={styles.barFill} style={{ width: `${Math.round((row.assignedCount / top) * 100)}%` }} /></span>
            <span className={styles.count}>{row.assignedCount}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * What deleting this team takes with it, as a sentence the operator reads
 * before they tick anything. The counts are real, read with the project list
 * (`teamRemovalImpact`), not guessed from the shape of the schema; the
 * deletion re-reads them inside its own transaction for the audit trail.
 */
function teamRemovalSummary(removal: BuilderProjectReview["removal"]): string {
  const parts: string[] = [];
  if (removal.rosterRows) parts.push(`${removal.rosterRows} roster row${removal.rosterRows === 1 ? "" : "s"}`);
  if (removal.joinLinksTotal) parts.push(`${removal.joinLinksTotal} join link${removal.joinLinksTotal === 1 ? "" : "s"} (${removal.openJoinLinks} still usable)`);
  if (removal.currentCaptain) parts.push("its current Captain assignment");
  if (removal.captainHistory > removal.currentCaptain) parts.push(`${removal.captainHistory - removal.currentCaptain} past Captain assignment${removal.captainHistory - removal.currentCaptain === 1 ? "" : "s"}`);
  if (removal.notes) parts.push(`${removal.notes} internal note${removal.notes === 1 ? "" : "s"}`);
  if (removal.gates) parts.push(`${removal.gates} submission gate tick${removal.gates === 1 ? "" : "s"}`);
  if (removal.finalist) parts.push("its finalist place");
  if (removal.judgeScores) parts.push(`${removal.judgeScores} judge score${removal.judgeScores === 1 ? "" : "s"}`);
  // Weekly reporting. The revision count is named separately from the entry
  // count because it is the edit history behind those entries, and this is
  // the only place in HQ where it can be removed at all.
  if (removal.reportingEntries) {
    parts.push(`${removal.reportingEntries} weekly update${removal.reportingEntries === 1 ? "" : "s"} with all ${removal.reportingRevisions} saved version${removal.reportingRevisions === 1 ? "" : "s"}`);
  } else if (removal.reportingEnrolled) {
    parts.push("its place in weekly reporting");
  }
  if (removal.reportingOutcomes) parts.push(`${removal.reportingOutcomes} recorded week${removal.reportingOutcomes === 1 ? "" : "s"}`);
  if (!parts.length) return "Nothing else is attached to it.";
  return `It also removes ${parts.join(", ")}.`;
}

/**
 * Delete team. Behind a <details> like the Captain revocation control, with
 * the same shape: real counts first, a required confirmation that states
 * them, then the destructive button. Nothing here is reversible, and the
 * copy says so.
 */
function DeleteTeam({ project }: { project: BuilderProjectReview }) {
  return (
    <details className={styles.review}>
      <summary>Delete team</summary>
      <ActionForm resetOnSuccess action={() => deleteBuilderTeam({ projectId: project.id, confirmed: true })}>
        <p>{teamRemovalSummary(project.removal)} The accounts of the people on it are not deleted, and an award this project won keeps its record without a winner. This cannot be undone.</p>
        <label className={styles.checkbox}>
          I confirm {project.name} should be removed from this hackathon entirely.
          <input name="confirm" type="checkbox" required />
        </label>
        <div className={styles.actions}><button className={styles.secondary} type="submit">Delete team</button></div>
      </ActionForm>
    </details>
  );
}

const STAGES: Record<string, string> = { idea: "Idea", mvp: "Prototype / MVP", beta: "Beta / devnet testing", live: "Live product", revenue: "Revenue-generating", growth: "Scaling / growth" };

export function BuilderProjectReviews({ projects, importRequests }: {
  projects: BuilderProjectReview[]; importRequests: BuilderImportRequest[];
}) {
  return (
    <>
      <section className={styles.section} aria-labelledby="imported-teams-title">
        <h2 id="imported-teams-title">Imported teams</h2>
        <p>Teams import themselves: a Netherlands project registered for this hackathon&apos;s Colosseum edition is in HQ the moment its builder pastes the link. There is no approval step to work through here.</p>
        {projects.length === 0 && <p>No teams have been imported into this hackathon yet.</p>}
        {projects.map((project) => (
          <article className={styles.row} key={project.id}>
            <div className={styles.rowHeader}>
              <h3>{project.name}</h3>
              <div className={styles.actions} style={{ marginTop: 0 }}>
                <span className={styles.badge}>{SUBMISSION_LABELS[project.submissionStatus]}</span>
                {project.highPotential && <span className={`${styles.badge} ${styles.potential}`}>High potential</span>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginTop: 12 }}>
              <BuilderProjectImage src={project.imageUrl} name={project.name} size={64} />
              <p style={{ margin: 0, minWidth: 0 }}>{project.description}</p>
            </div>
            <p><a href={projectHref(project.projectUrl)} target="_blank" rel="noopener noreferrer">View project on Colosseum</a></p>
            <p>Country: <strong>{project.country || "Not provided"}</strong><br />Stage: {STAGES[project.stage] ?? project.stage}<br />Lead: {project.leadUsername ? `@${project.leadUsername}` : "Not selected"}<br />
              Category: {project.category || "Not provided"}{project.twitterHandle ? <> · X handle on Colosseum: @{project.twitterHandle}</> : null}</p>
            <p>
              {project.submittedAt ? `Submitted to Colosseum on ${project.submittedAt.slice(0, 10)}.` : "No Colosseum submission timestamp recorded."}{" "}
              {project.sourceCheckedAt ? `Source last read on ${project.sourceCheckedAt.slice(0, 10)}.` : "Source never read."}{" "}
              {project.sourceStatus === "error" && `Last check failed (${project.sourceErrorCode ?? "unknown"}${project.sourceErrorMessage ? `: ${project.sourceErrorMessage}` : ""}); the status above is the previous known state.`}
            </p>
            <p>Imported by {project.ownerName} ({loginLabel(project.owner)}).</p>
            <ul className={styles.roster} aria-label={`${project.name} team members`}>
              {project.members.map((member, index) => <li key={member.username || `${member.name}-${index}`}>
                <span>{member.name}{member.username ? ` (@${member.username})` : ""}{member.username === project.leadUsername ? " (lead)" : ""}</span>
                <span className={styles.badge}>{member.joined ? "Joined HQ" : "Not joined"}</span>
              </li>)}
            </ul>
            {project.members.length === 0 && <p>No Colosseum roster was imported for this project.</p>}
            {project.members.some((member) => member.username) && <ActionForm action={(data) => updateBuilderProjectLead(project.id, String(data.get("lead") ?? ""))}>
              <div className={styles.tier}>
                <label>Team lead<select name="lead" defaultValue={project.leadUsername} required>{project.members.filter((member) => member.username).map((member) => <option key={member.username} value={member.username}>{member.name} (@{member.username})</option>)}</select></label>
                <button className={styles.secondary} type="submit">Save lead</button>
              </div>
            </ActionForm>}
            <ActionForm action={() => markBuilderProjectPotential(project.id, !project.highPotential)}>
              <div className={styles.actions}><button className={styles.secondary} type="submit">{project.highPotential ? "Remove high potential flag" : "Mark high potential"}</button></div>
            </ActionForm>
            <DeleteTeam project={project} />
          </article>
        ))}
      </section>
      <section className={styles.section} aria-labelledby="import-requests-title">
        <h2 id="import-requests-title">Import requests</h2>
        <p>
          Projects that Colosseum could not return. Create the HQ project here and the account that asked gets its team page, its weekly updates and a
          Captain straight away; when Colosseum can return the project, link it to that same project rather than importing a second one.
        </p>
        {importRequests.length === 0 && <p>No import requests need attention.</p>}
        {importRequests.map((request) => <article className={styles.row} key={request.id}>
          <div className={styles.rowHeader}><h3>{request.name}</h3><span className={styles.badge}>{request.status}</span></div>
          <p>{loginLabel(request)}</p><p><a href={projectHref(request.projectUrl)} target="_blank" rel="noopener noreferrer">{request.projectUrl}</a></p><p>{request.note}</p>
          {/* Creating the project is what actually answers the request: no
              Colosseum id is invented for it, and nothing about it is marked
              submitted. Linking the source later keeps this same project. */}
          {request.projectId
            ? <>
                <p>HQ project: {request.projectName}. It has no Colosseum project linked yet.</p>
                <ActionForm action={(data) => attachColosseumProject({ projectId: request.projectId!, url: String(data.get("url") ?? "") })}>
                  <div className={styles.grid}>
                    <label className={styles.field}>Colosseum project URL<input name="url" type="url" defaultValue={request.projectUrl} required /></label>
                  </div>
                  <div className={styles.actions}><button className={styles.secondary} type="submit">Link this Colosseum project</button></div>
                </ActionForm>
              </>
            : <ActionForm action={(data) => createProjectFromImportRequest({ requestId: request.id, name: String(data.get("name") ?? "") })}>
                <div className={styles.grid}>
                  <label className={styles.field}>Project name in HQ<input name="name" defaultValue={""} maxLength={200} required /></label>
                </div>
                <div className={styles.actions}><button className={styles.secondary} type="submit">Create the HQ project</button></div>
              </ActionForm>}
          {request.status === "pending" && <ActionForm action={() => resolveBuilderImportRequest(request.id)}>
            <div className={styles.actions}><button className={styles.secondary} type="submit">Mark resolved</button></div>
          </ActionForm>}
        </article>)}
      </section>
    </>
  );
}
