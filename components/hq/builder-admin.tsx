"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import {
  markBuilderProjectPotential, resolveBuilderImportRequest, reviewBuilderHostRequest,
  reviewBuilderProject, updateBuilderOnboardingConfig, updateBuilderProjectLead, updateBuilderTier,
} from "@/lib/hq/actions/builders-admin";
import { grantCaptainCapability, revokeCaptainCapability } from "@/lib/hq/actions/capabilities";
import type {
  AccountLogin, ActiveCaptain, BuilderAccount, BuilderHostRequest, BuilderImportRequest, BuilderProjectReview, OnboardingConfig,
} from "@/lib/hq/builder-admin-queries";
import type { ActionResult } from "@/lib/hq/types";
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
function ActionForm({ action, children }: { action: (data: FormData) => Promise<ActionResult>; children: ReactNode }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
    setMessage("");
    setError(false);
    startTransition(async () => {
      try {
        const result = await action(data);
        setError(!result.ok);
        setMessage(result.ok ? "Saved." : result.error ?? "Could not save. Try again.");
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

export function BuilderAdmin({ config, hackathonName, accounts, captains, hostRequests }: {
  config: OnboardingConfig; hackathonName: string; accounts: BuilderAccount[]; captains: ActiveCaptain[]; hostRequests: BuilderHostRequest[];
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
            <ActionForm action={(data) => (account.captain ? revokeCaptainCapability : grantCaptainCapability)(account.id, String(data.get("reason") ?? ""))}>
              <label className={styles.field}>Reason<input name="reason" required minLength={3} maxLength={500} placeholder={account.captain ? "Why this account loses Captain access." : "Why this account gets Captain access."} /></label>
              <label className={styles.checkbox}>
                {account.captain
                  ? "I confirm this account should lose Captain access. Its assignments stop opening on the next request."
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

const STAGES: Record<string, string> = { idea: "Idea", mvp: "Prototype / MVP", beta: "Beta / devnet testing", live: "Live product", revenue: "Revenue-generating", growth: "Scaling / growth" };

export function BuilderProjectReviews({ projects, importRequests }: {
  projects: BuilderProjectReview[]; importRequests: BuilderImportRequest[];
}) {
  return (
    <>
      <section className={styles.section} aria-labelledby="imported-teams-title">
        <h2 id="imported-teams-title">Imported teams</h2>
        <p>Team verification and HQ membership are separate from the submission gates above.</p>
        {projects.length === 0 && <p>No teams have been imported into this hackathon yet.</p>}
        {projects.map((project) => (
          <article className={styles.row} key={project.id}>
            <div className={styles.rowHeader}>
              <h3>{project.name}</h3>
              <div className={styles.actions} style={{ marginTop: 0 }}>
                <span className={styles.badge}>{project.verification === "pending" ? "Awaiting approval" : project.verification}</span>
                {project.highPotential && <span className={`${styles.badge} ${styles.potential}`}>High potential</span>}
              </div>
            </div>
            <p>{project.description}</p>
            <p><a href={projectHref(project.projectUrl)} target="_blank" rel="noopener noreferrer">View project on Colosseum</a></p>
            <p>Country: <strong>{project.country || "Not provided"}</strong><br />Stage: {STAGES[project.stage] ?? project.stage}<br />Lead: {project.leadUsername ? `@${project.leadUsername}` : "Not selected"}</p>
            <p>Initialized by {project.ownerName} ({loginLabel(project.owner)}).</p>
            <ul className={styles.roster} aria-label={`${project.name} team members`}>
              {project.members.map((member, index) => <li key={member.username || `${member.name}-${index}`}>
                <span>{member.name}{member.username ? ` (@${member.username})` : ""}{member.username === project.leadUsername ? " (lead)" : ""}</span>
                <span className={styles.badge}>{member.joined ? "Joined HQ" : "Not joined"}</span>
              </li>)}
            </ul>
            {project.members.length === 0 && <p>No Colosseum roster was imported. Review the project before approval.</p>}
            {project.members.some((member) => member.username) && <ActionForm action={(data) => updateBuilderProjectLead(project.id, String(data.get("lead") ?? ""))}>
              <div className={styles.tier}>
                <label>Team lead<select name="lead" defaultValue={project.leadUsername} required>{project.members.filter((member) => member.username).map((member) => <option key={member.username} value={member.username}>{member.name} (@{member.username})</option>)}</select></label>
                <button className={styles.secondary} type="submit">Save lead</button>
              </div>
            </ActionForm>}
            <p>{project.proofCommentId ? `Verification comment #${project.proofCommentId}, author #${project.proofAuthorId ?? "unknown"}.` : "No matching verification comment is recorded."} <a href={`https://api.colosseum.com/api/project/comments?projectId=${project.externalId}&offset=0`} target="_blank" rel="noopener noreferrer">View Colosseum comments</a></p>
            <ActionForm action={() => markBuilderProjectPotential(project.id, !project.highPotential)}>
              <div className={styles.actions}><button className={styles.secondary} type="submit">{project.highPotential ? "Remove high potential flag" : "Mark high potential"}</button></div>
            </ActionForm>
            <details className={styles.review}>
              <summary>{project.verification === "pending" ? "Review team verification" : "Change team verification"}</summary>
              <ActionForm action={(data) => reviewBuilderProject({ projectId: project.id,
                decision: data.get("decision") === "verified" ? "verified" : "rejected",
                reviewedEvidence: data.has("reviewed") as true, note: String(data.get("note") ?? ""),
              })}>
                <label className={styles.checkbox}>I checked the Colosseum project, Netherlands registration, owner and listed team.<input name="reviewed" type="checkbox" required /></label>
                <label className={styles.field}>Review note<textarea name="note" required minLength={12} maxLength={2000} rows={3} placeholder="Record the evidence for your decision." /></label>
                <div className={styles.actions}>
                  <button className={styles.button} name="decision" value="verified" type="submit">Approve team</button>
                  <button className={styles.secondary} name="decision" value="rejected" type="submit">Reject team</button>
                </div>
              </ActionForm>
            </details>
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
