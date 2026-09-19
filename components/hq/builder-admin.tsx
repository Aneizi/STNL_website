"use client";

import { useRef, useState, useSyncExternalStore, useTransition, type FormEvent, type ReactNode } from "react";
import { updateBuilderOnboardingConfig } from "@/lib/hq/actions/builders-admin";
import { createCaptainInvitation, revokeCaptainInvitation } from "@/lib/hq/actions/captains";
import type { AccountLogin, AdminCaptainLeaderboardRow, OnboardingConfig } from "@/lib/hq/builder-admin-queries";
import type { CaptainInvitationListing } from "@/lib/hq/captains";
import { fmtWithZone } from "@/lib/hq/format";
import { inviteLink } from "@/lib/hq/member-routes";
import type { ActionResult } from "@/lib/hq/types";
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

/**
 * The shared submit-and-report form of the operator Admin and Projects
 * sections: its outcome line ("Saved." or the action's error) is local
 * state, so a row keyed by its record id keeps the line through the
 * revalidatePath round trip. The fields are never reset on success on
 * purpose: they take their defaultValue from server props (the onboarding
 * settings, an import request's URL), and a reset would briefly snap the
 * pre-save value back next to "Saved." before the fresh props arrive.
 */
export function ActionForm({ action, children }: { action: (data: FormData) => Promise<ActionResult>; children: ReactNode }) {
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

/** A Colosseum project URL as an href, or undefined for anything that is not one (rendered as plain text instead). */
export function projectHref(value: string): string | undefined {
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
          <p>Invitation code: <strong>{created.token}</strong></p>
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
