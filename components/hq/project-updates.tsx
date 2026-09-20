"use client";

import { useEffect, useState } from "react";
import { loadProjectReportingUpdates, loadProjectColosseumUpdates } from "@/lib/hq/actions/reporting-admin";
import { ColosseumUpdates } from "./colosseum-updates";
import type { ReportingEntryPage } from "@/lib/hq/reporting";
import { entryMetaLabel, mergeUpdatePages } from "@/lib/hq/reporting-view";
import styles from "./project-updates.module.css";

/** Mounted only for the expanded project. The admin reader includes private Captain notes. */
export function ProjectUpdates({ projectId, timezone }: { projectId: string; timezone: string }) {
  const [request, setRequest] = useState<{ cursor?: string; attempt: number }>({ attempt: 0 });
  const [state, setState] = useState<{ page: ReportingEntryPage | null; loading: boolean; error: string }>({
    page: null, loading: true, error: "",
  });

  useEffect(() => {
    let active = true;
    loadProjectReportingUpdates({ projectId, cursor: request.cursor }).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setState(previous => ({ ...previous, loading: false, error: result.error }));
        return;
      }
      setState(previous => ({
        page: {
          entries: request.cursor ? mergeUpdatePages(previous.page?.entries ?? [], result.page.entries) : result.page.entries,
          nextCursor: result.page.nextCursor,
        },
        loading: false,
        error: "",
      }));
    }).catch(() => {
      if (active) setState(previous => ({ ...previous, loading: false, error: "Updates could not be loaded. Try again." }));
    });
    return () => { active = false; };
  }, [projectId, request]);

  const load = (cursor?: string) => {
    setState(previous => ({ ...previous, loading: true, error: "" }));
    setRequest(previous => ({ cursor, attempt: previous.attempt + 1 }));
  };

  return (
    <><section aria-label="Team and captain updates" className={styles.updates} aria-busy={state.loading}>
      <div className={styles.heading}>
        <h3>Team &amp; captain updates</h3>
        <button type="button" onClick={() => load()} disabled={state.loading}>Refresh updates</button>
      </div>
      {state.page?.entries.map(entry => (
        <article key={entry.id} className={styles.entry}>
          <p className={styles.meta}>
            <span>{entryMetaLabel(entry, timezone)}</span>
            {entry.source === "telegram" && <span>Via Telegram</span>}
            {entry.visibility === "sensitive" && <span className={styles.tag}>Private</span>}
            {entry.voided && <span className={styles.tag}>Voided</span>}
          </p>
          <p className={styles.body}>{entry.body}</p>
        </article>
      ))}
      {state.loading && <p role="status" className={styles.message}>Loading updates…</p>}
      {!state.loading && !state.error && state.page?.entries.length === 0 && (
        <p className={styles.message}>No team or captain updates yet.</p>
      )}
      {state.error && <div role="alert">
        <p className={styles.message}>{state.error}</p>
        <button type="button" onClick={() => load(request.cursor)} disabled={state.loading}>Try again</button>
      </div>}
      {state.page?.nextCursor && !state.error && (
        <button type="button" onClick={() => load(state.page!.nextCursor!)} disabled={state.loading}>Load older updates</button>
      )}
    </section>
    <ColosseumUpdates projectId={projectId} timezone={timezone} loadUpdates={loadProjectColosseumUpdates} /></>
  );
}
