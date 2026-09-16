"use client";

import { useState, useTransition } from "react";
import { loadOwnUpdates } from "@/lib/hq/actions/reporting";
import type { OwnReportingEntry } from "@/lib/hq/reporting";
import styles from "./builder-shell.module.css";

/**
 * A Captain's own updates, read-only, across every project they have written
 * one for in this hackathon.
 *
 * Read-only is the whole point, not a simplification. `readOwnUpdates` gives
 * the author back their own notes after a reassignment, which the permission
 * contract always intended and no screen could reach; what it deliberately
 * does not give back is any other record of the team they used to hold. So
 * there is no editor here and no composer: editing an update still runs
 * through the project's own page, where the project decides.
 */
export function OwnReportingNotes({
  initial,
  initialCursor,
}: {
  initial: OwnReportingEntry[];
  initialCursor: string | null;
}) {
  const [entries, setEntries] = useState(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [pending, start] = useTransition();
  const [error, setError] = useState("");

  if (!entries.length) return <p>You have not written any updates in this hackathon yet.</p>;

  return (
    <>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {entries.map((entry) => (
        <div className={styles.card} key={entry.id}>
          {entry.visibility === "sensitive" && <span className={styles.status}>Only you and Superteam NL admins</span>}
          <h3>{entry.projectName}</h3>
          <p style={{ whiteSpace: "pre-wrap", color: "#16130f" }}>{entry.body}</p>
          <small>
            Week {entry.periodSequence}, {entry.submittedAt.slice(0, 10)}
            {entry.edited ? ", edited since" : ""}
            {entry.late ? ", added after the week ended" : ""}
          </small>
        </div>
      ))}
      {cursor && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError("");
                try {
                  const page = await loadOwnUpdates({ cursor });
                  setEntries((current) => [...current, ...page.entries]);
                  setCursor(page.nextCursor);
                } catch {
                  setError("Your notes could not be loaded. Please try again.");
                }
              })
            }
          >
            {pending ? "Loading" : "Show older updates"}
          </button>
        </div>
      )}
    </>
  );
}
