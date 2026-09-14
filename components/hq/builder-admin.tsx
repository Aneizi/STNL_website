"use client";

import { useRef, useState, useSyncExternalStore, useTransition, type FormEvent, type ReactNode } from "react";
import {
  deleteBuilderTeam, markBuilderProjectPotential, resolveBuilderImportRequest, reviewBuilderHostRequest,
  updateBuilderOnboardingConfig, updateBuilderProjectLead, updateBuilderTier,
} from "@/lib/hq/actions/builders-admin";
import { grantCaptainCapability, revokeCaptainCapability } from "@/lib/hq/actions/capabilities";
import { createCaptainInvitation, revokeCaptainInvitation } from "@/lib/hq/actions/captains";
import type {
  AccountLogin, ActiveCaptain, BuilderAccount, BuilderHostRequest, BuilderImportRequest, BuilderProjectReview, OnboardingConfig,
} from "@/lib/hq/builder-admin-queries";
import type { CaptainInvitationListing, CurrentCaptainAssignment } from "@/lib/hq/captains";
import { SUBMISSION_LABELS } from "@/lib/hq/colosseum-snapshot";
import { fmtWithZone } from "@/lib/hq/format";
import { inviteLink } from "@/lib/hq/member-routes";
import type { ActionResult } from "@/lib/hq/types";
import type { CaptainLeaderboardView } from "@/lib/hq/view-models";
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

export function BuilderAdmin({
  config, hackathonName, accounts, captains, hostRequests, captainInvitations, captainLeaderboard, captainAssignments, timezone,
}: {
  config: OnboardingConfig; hackathonName: string; accounts: BuilderAccount[]; captains: ActiveCaptain[]; hostRequests: BuilderHostRequest[];
  captainInvitations: CaptainInvitationListing[]; captainLeaderboard: CaptainLeaderboardView[]; captainAssignments: CurrentCaptainAssignment[];
  timezone: string;
}) {
  return (
    <>
      <section className={styles.section} aria-labelledby="builder-onboarding-title">
        <h2 id="builder-onboarding-title">Builder onboarding</h2>
        <p>Settings for {hackathonName}. Colosseum IDs are separate from HQ IDs. Leave project imports off until Colosseum provides access.</p>
        <ActionForm action={(data) => updateBuilderOnboardingConfig({
          externalHackathonId: String(data.get("externalId") ?? "").trim() ? Number(data.get("externalId")) : null,
          externalHackathonSlug: String(data.get("externalSlug") ?? ""),
          projectsOpen: data.has("projectsOpen"),
          projectsAvailableAt: data.get("availableAt") ? new Date(`${data.get("availableAt")}:00Z`).toISOString() : "",
          signupUrl: String(data.get("signupUrl") ?? ""),
          hostingEnabled: data.has("hostingEnabled"),
        })}>
          <div className={styles.grid}>
            <label className={styles.field}>Colosseum hackathon ID<input name="externalId" inputMode="numeric" pattern="[0-9]+" defaultValue={config.externalHackathonId ?? ""} /></label>
            <label className={styles.field}>Colosseum hackathon slug<input name="externalSlug" defaultValue={config.externalHackathonSlug} maxLength={200} spellCheck={false} /></label>
            <label className={styles.field}>Project access date (UTC)<input name="availableAt" type="datetime-local" defaultValue={localDateTime(config.projectsAvailableAt)} /></label>
            <label className={styles.field}>Colosseum signup URL<input name="signupUrl" type="url" defaultValue={config.signupUrl} required /></label>
          </div>
          <label className={styles.checkbox}>Enable project imports<input name="projectsOpen" type="checkbox" defaultChecked={config.projectsOpen} /></label>
          <label className={styles.checkbox}>Allow Members to apply to host events<input name="hostingEnabled" type="checkbox" defaultChecked={config.hostingEnabled} /></label>
          <div className={styles.actions}><button className={styles.button} type="submit">Save onboarding settings</button></div>
        </ActionForm>
      </section>
      <BuilderAccounts accounts={accounts} captains={captains} />
      <CaptainInvitations invitations={captainInvitations} timezone={timezone} />
      <CaptainLeaderboard hackathonName={hackathonName} leaderboard={captainLeaderboard} assignments={captainAssignments} />
      <section className={styles.section} aria-labelledby="hosting-requests-title">
        <h2 id="hosting-requests-title">Event hosting requests</h2>
        <p>{config.hostingEnabled ? "Members can apply to host an event." : "Applications are disabled. Enable them in onboarding settings when ready."}</p>
        {hostRequests.length === 0 && <p>No hosting requests yet.</p>}
        {hostRequests.map((request) => (
          <article className={styles.row} key={request.id}>
            <div className={styles.rowHeader}><h3>{request.title}</h3><span className={styles.badge}>{request.status}</span></div>
            <p>{request.name} ({loginLabel(request)})</p><p>{request.details}</p>
            {request.status === "pending" && <ActionForm action={(data) => reviewBuilderHostRequest(request.id, data.get("decision") === "approved" ? "approved" : "declined")}>
              <div className={styles.actions}>
                <button className={styles.button} name="decision" value="approved" type="submit">Approve request</button>
                <button className={styles.secondary} name="decision" value="declined" type="submit">Decline</button>
              </div>
            </ActionForm>}
          </article>
        ))}
      </section>
    </>
  );
}

export function BuilderAccounts({ accounts, captains }: { accounts: BuilderAccount[]; captains: ActiveCaptain[] }) {
  return (
    <section className={styles.section} aria-labelledby="builder-accounts-title">
      <h2 id="builder-accounts-title">HQ accounts</h2>
      <p>Accounts in this hackathon&apos;s People list. Membership applies across all hackathons and never grants admin access.</p>
      <p>Captain access is an account capability, separate from People roles and from membership. It shows as a locked Captain tag in People and opens no project until a Captain is assigned to it.</p>
      <p>{captains.length === 0 ? "No account holds Captain access yet." : `Active Captains across all hackathons: ${captains.length}.`}</p>
      {captains.length > 0 && <ul className={styles.roster} aria-label="Active Captains">
        {captains.map((captain) => <li key={captain.userId}>
          <span>{captain.name}{captain.reason ? ` (${captain.reason})` : ""}</span>
          <span className={styles.badge}>Since {captain.grantedAt.slice(0, 10)}</span>
        </li>)}
      </ul>}
      {accounts.length === 0 && <p>No HQ accounts have joined this hackathon yet.</p>}
      {accounts.map((account) => (
        <article className={styles.row} key={account.id}>
          <div className={styles.rowHeader}>
            <h3>{account.name}</h3>
            {account.captain && <span className={`${styles.badge} ${styles.potential}`}>Captain</span>}
          </div>
          <p>{loginLabel(account)}</p>
          {account.contactEmail && <p>Contact email: {account.contactEmail}</p>}
          <ActionForm action={(data) => updateBuilderTier(account.id, data.get("tier") === "member" ? "member" : "regular")}>
            <div className={styles.tier}>
              <label>Membership<select name="tier" defaultValue={account.tier}><option value="regular">Regular</option><option value="member">Member</option></select></label>
              <button className={styles.secondary} type="submit">Save membership</button>
            </div>
          </ActionForm>
          <details className={styles.review}>
            <summary>{account.captain ? "Revoke Captain access" : "Grant Captain access"}</summary>
            <ActionForm resetOnSuccess action={(data) => (account.captain ? revokeCaptainCapability : grantCaptainCapability)(account.id, String(data.get("reason") ?? ""))}>
              <label className={styles.field}>Reason<input name="reason" required minLength={3} maxLength={500} placeholder={account.captain ? "Why this account loses Captain access." : "Why this account gets Captain access."} /></label>
              <label className={styles.checkbox}>
                {account.captain
                  ? account.captainAssignmentCount > 0
                    ? `I confirm this account should lose Captain access. It currently captains ${account.captainAssignmentCount} project${account.captainAssignmentCount === 1 ? "" : "s"}; revoking clears ${account.captainAssignmentCount === 1 ? "it" : "all of them"} in the same action.`
                    : "I confirm this account should lose Captain access. It captains no project right now."
                  : "I confirm this account should have Captain access. It opens no project until an assignment exists."}
                <input name="confirm" type="checkbox" required />
              </label>
              <div className={styles.actions}>
                <button className={account.captain ? styles.secondary : styles.button} type="submit">{account.captain ? "Revoke Captain" : "Grant Captain"}</button>
              </div>
            </ActionForm>
          </details>
        </article>
      ))}
    </section>
  );
}

const INVITATION_STATE_LABELS: Record<CaptainInvitationListing["state"], string> = {
  active: "Active", expired: "Expired", revoked: "Revoked", full: "Full",
};

/**
 * The moment this form hydrated on the client, or null on the server and on
 * the client's own first (hydrating) render. Date.now() is impure — calling
 * it directly in a component body is against the rules of React (it would
 * also disagree with the server's render, a hydration mismatch) — so the one
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
 * useClientNow), so the first client render still matches the server's —
 * the same hydration problem localDateTime above solves a different way, by
 * only ever formatting a fixed UTC value instead of "now".
 */
function useExpiryPreview(days: number, timezone: string): string {
  const now = useClientNow();
  if (now == null || !Number.isFinite(days) || days <= 0) return "";
  return fmtWithZone(new Date(now + days * 86_400_000).toISOString(), timezone);
}

/**
 * Captain invitations: admin-generated links that grant the Captain
 * capability only, never operator access and never a project assignment.
 * Rendered near BuilderAccounts' own Captain copy, since both surfaces touch
 * the same hq_account_capabilities grant, just by two different routes.
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
        // requireUser() throws on an expired or lost operator session — the
        // most likely failure on a long-open Admin tab — and the action
        // rethrows anything that is not a BuilderError.
        setError("Could not create the invitation. Try again.");
      }
    });
  }

  const link = created ? `${window.location.origin}${inviteLink(created.token)}` : "";

  return (
    <section className={styles.section} aria-labelledby="captain-invitations-title">
      <h2 id="captain-invitations-title">Captain invitations</h2>
      <p>A link grants Captain access only — never operator access and never a project assignment. Assigning a Captain to a project is a separate step.</p>
      <p>A multi-use link authorizes several verified accounts at once. Keep Maximum connected accounts at 1 unless several people genuinely share this link — the default is deliberately one-use.</p>
      <form onSubmit={submit} aria-busy={pending}>
        <fieldset disabled={pending} className={styles.fieldset}>
          <div className={styles.grid}>
            <label className={styles.field}>Internal label (optional)<input name="label" maxLength={200} placeholder="e.g. Rotterdam meetup" /></label>
            <label className={styles.field}>Maximum connected accounts<input name="maxRedemptions" type="number" inputMode="numeric" min={1} max={500} defaultValue={1} required /></label>
            <label className={styles.field}>Valid for (days)<input name="validForDays" type="number" inputMode="numeric" min={1} max={365} defaultValue={7} required onChange={(event) => setDays(Number(event.currentTarget.value))} /></label>
          </div>
          <p className={styles.muted}>{preview ? `Expires ${preview}, unless revoked sooner.` : "Choose a duration to see the expiry."}</p>
          <div className={styles.actions}><button className={styles.button} type="submit">Create invitation link</button></div>
        </fieldset>
        {(pending || error) && <div className={`${styles.feedback} ${error ? styles.error : ""}`} role={error ? "alert" : "status"}>{pending ? "Creating…" : error}</div>}
      </form>
      {created && (
        <div className={styles.row} role="status">
          <p><strong>Copy this link now — it will not be shown again.</strong></p>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12, overflowWrap: "anywhere" }}>{link}</span>
            <CopyButton value={link} />
          </div>
        </div>
      )}
      {invitations.length === 0 && <p>No Captain invitations yet.</p>}
      {invitations.map((invitation) => (
        <article className={styles.row} key={invitation.id}>
          <div className={styles.rowHeader}>
            <h3>{invitation.label || "Untitled invitation"}</h3>
            <span className={styles.badge}>{INVITATION_STATE_LABELS[invitation.state]}</span>
          </div>
          <p>{invitation.usedCount} of {invitation.maxRedemptions} accounts used. Expires {fmtWithZone(invitation.expiresAt, timezone)}.</p>
          <p>Created by {invitation.createdByName ?? "a since-removed operator"} on {invitation.createdAt.slice(0, 10)}.</p>
          {invitation.redeemers.length > 0 && (
            <ul className={styles.roster} aria-label={`${invitation.label || "Untitled invitation"} redeemers`}>
              {invitation.redeemers.map((redeemer, index) => (
                <li key={redeemer.userId ?? `deleted-${index}`}>
                  <span>{redeemer.name ?? "Deleted account"}</span>
                  <span className={styles.badge}>{redeemer.redeemedAt.slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          )}
          {invitation.state !== "revoked" && (
            <ActionForm action={() => revokeCaptainInvitation(invitation.id)}>
              <div className={styles.actions}><button className={styles.secondary} type="submit">Revoke invitation</button></div>
            </ActionForm>
          )}
          <p className={styles.muted}>Revoking stops future redemptions only. Accounts that already used this link keep Captain access until it is revoked for that account above.</p>
        </article>
      ))}
    </section>
  );
}

/**
 * The Captain leaderboard, edition-scoped, plus its drilldown — the one
 * operator-only extra a Captain's own copy of this list never carries.
 * `leaderboard` is the exact rank/name/count shape a Captain sees on their
 * own dashboard (lib/hq/captains.ts#leaderboard, shared and separately
 * gated at each call site); `assignments` is the wider admin-only read
 * (`listAssignments`, with account ids), grouped here by Captain to answer
 * "which projects does this Captain currently hold" without threading an id
 * through the privacy-shaped leaderboard rows above.
 */
function CaptainLeaderboard({ hackathonName, leaderboard, assignments }: {
  hackathonName: string; leaderboard: CaptainLeaderboardView[]; assignments: CurrentCaptainAssignment[];
}) {
  const byCaptain = new Map<string, { name: string; projects: Array<{ id: string; name: string }> }>();
  for (const row of assignments) {
    const entry = byCaptain.get(row.captainUserId) ?? { name: row.captainName, projects: [] };
    entry.projects.push({ id: row.projectId, name: row.projectName });
    byCaptain.set(row.captainUserId, entry);
  }
  return (
    <section className={styles.section} aria-labelledby="captain-leaderboard-title">
      <h2 id="captain-leaderboard-title">Captain leaderboard — {hackathonName}</h2>
      <p>Current assigned-team counts for this hackathon&apos;s active projects. An account with an active Captain grant still appears at zero until it holds one.</p>
      {leaderboard.length === 0 && <p>No account holds Captain access yet.</p>}
      {leaderboard.length > 0 && (
        <ol className={styles.roster} aria-label="Captain leaderboard">
          {leaderboard.map((row) => (
            <li key={row.rank}>
              <span>{row.rank}. {row.displayName}</span>
              <span className={styles.badge}>{row.assignedCount} project{row.assignedCount === 1 ? "" : "s"}</span>
            </li>
          ))}
        </ol>
      )}
      <p>Which projects each Captain currently holds, including projects whose status does not count as active (so this list can name a project the count above does not include):</p>
      {byCaptain.size === 0 && <p>No project currently has a Captain in this hackathon.</p>}
      {[...byCaptain.entries()].map(([userId, entry]) => (
        <article className={styles.row} key={userId}>
          <h3>{entry.name}</h3>
          <ul className={styles.roster} aria-label={`${entry.name} projects`}>
            {entry.projects.map((project) => <li key={project.id}><span>{project.name}</span></li>)}
          </ul>
        </article>
      ))}
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
        <p>Projects that Colosseum could not return. Help the builder complete the import before marking the request resolved.</p>
        {importRequests.length === 0 && <p>No import requests need attention.</p>}
        {importRequests.map((request) => <article className={styles.row} key={request.id}>
          <div className={styles.rowHeader}><h3>{request.name}</h3><span className={styles.badge}>{request.status}</span></div>
          <p>{loginLabel(request)}</p><p><a href={projectHref(request.projectUrl)} target="_blank" rel="noopener noreferrer">{request.projectUrl}</a></p><p>{request.note}</p>
          {request.status === "pending" && <ActionForm action={() => resolveBuilderImportRequest(request.id)}>
            <div className={styles.actions}><button className={styles.secondary} type="submit">Mark resolved</button></div>
          </ActionForm>}
        </article>)}
      </section>
    </>
  );
}
