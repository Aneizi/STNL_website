"use client";

import { useEffect, useState } from "react";
import type { ColosseumHistoryPage, ColosseumHistoryResult } from "@/lib/hq/colosseum-updates";
import styles from "./colosseum-updates.module.css";

export function ColosseumUpdates({ projectId, hackathonId, timezone, loadUpdates }: {
  projectId: string;
  hackathonId?: number;
  timezone: string;
  loadUpdates: (input: { projectId: string; hackathonId?: number; cursor?: string }) => Promise<ColosseumHistoryResult>;
}) {
  const [request, setRequest] = useState<{ cursor?: string; attempt: number }>({ attempt: 0 });
  const [page, setPage] = useState<ColosseumHistoryPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    loadUpdates({ projectId, hackathonId, cursor: request.cursor }).then(result => {
      if (!active) return;
      setLoading(false);
      if (!result.ok) { setError(result.error); return; }
      setError("");
      setPage(previous => ({ ...result.page, updates: request.cursor && previous
        ? [...new Map([...previous.updates, ...result.page.updates].map(update => [update.externalId, update])).values()]
        : result.page.updates }));
      // Continue older pages automatically. Each fresh sweep starts at the
      // newest page so an open, paginated history also picks up new posts.
      if (result.page.linked) timer = setTimeout(() => {
        setRequest(current => ({ cursor: result.page.syncingOlder ? current.cursor : undefined, attempt: current.attempt + 1 }));
      }, result.page.syncFailed ? 15 * 60_000 : result.page.syncingOlder ? 10_000 : 30 * 60_000);
    }).catch(() => {
      if (active) { setLoading(false); setError("Colosseum updates could not be loaded. Try again."); }
    });
    return () => { active = false; clearTimeout(timer); };
  }, [projectId, hackathonId, loadUpdates, request]);

  const load = (cursor?: string) => {
    setLoading(true);
    setRequest(current => ({ cursor, attempt: current.attempt + 1 }));
  };
  if (page && !page.linked && !error) return null;
  return <section className={styles.history} aria-label="Colosseum updates" aria-busy={loading}>
    <div className={styles.heading}>
      <h3>Colosseum updates</h3>
      <button type="button" disabled={loading} onClick={() => load()}>Refresh</button>
    </div>
    {page?.updates.map(update => <article className={styles.update} key={update.externalId}>
      <p className={styles.meta}>{update.authorName}{", "}
        <time dateTime={update.publishedAt}>{new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: timezone }).format(new Date(update.publishedAt))}</time>
      </p>
      {update.body && <p className={styles.body}>{update.body}</p>}
      {update.links.length > 0 && <ul className={styles.links}>{update.links.map(link => <li key={link}>
        <a href={link} target="_blank" rel="noopener noreferrer">{link}</a>
      </li>)}</ul>}
      <a className={styles.source} href={update.sourceUrl} target="_blank" rel="noopener noreferrer">View on Colosseum</a>
    </article>)}
    {loading && <p role="status">Loading Colosseum updates…</p>}
    {page?.syncingOlder && !page.syncFailed && <p role="status">Fetching older Colosseum updates…</p>}
    {page?.syncFailed && <p role="status">Colosseum could not be reached. Saved updates are kept and will be retried automatically.</p>}
    {!loading && !error && page?.updates.length === 0 && !page.syncFailed && <p>No public Colosseum updates yet.</p>}
    {error && <p role="alert">{error}</p>}
    {page?.nextCursor && <button type="button" disabled={loading} onClick={() => load(page.nextCursor!)}>Load older updates</button>}
  </section>;
}
