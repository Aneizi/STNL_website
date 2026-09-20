"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { editReportingUpdate } from "@/lib/hq/actions/reporting";
import type { ReportingEntryView } from "@/lib/hq/reporting";
import { validUpdateBody } from "@/lib/hq/reporting-body";
import { UpdateTextarea } from "./update-textarea";
import styles from "./reporting-entry-card.module.css";


export type ReportingEntryCardProps = {
  entry: ReportingEntryView;
  /**
   * The meta line, worded by the caller with `entryMetaLabel` or
   * `captainMetaLabel` from lib/hq/reporting-view.ts. This card never formats
   * a date and never says "(you)": which of the two readings applies is the
   * page's decision, not the card's.
   */
  meta: string;
  /** Whether to offer the inline editor. The caller reads it off `entry.canEdit`, or withholds it on a page that has no editing. */
  canEdit: boolean;
  /** Something after the meta text, such as the Captains' Den's private tag. */
  tag?: React.ReactNode;
  /** The entry as saved, so the list replaces its older version. */
  onSaved: (entry: ReportingEntryView) => void;
};

/**
 * The saved version's meta when an edit lost a race. It is the same entry,
 * by the same author, in the same week, so the caller's meta still describes
 * it; all that can differ is that it has now been edited.
 */
function conflictMeta(meta: string, current: ReportingEntryView): string {
  return current.edited && !meta.endsWith(", edited") ? `${meta}, edited` : meta;
}

/**
 * One update or note, reading or editing.
 *
 * An edit is bound to the version the editor was opened against, so an entry
 * that changed elsewhere in the meantime comes back as a conflict rather than
 * being overwritten. A conflict keeps the draft exactly where it was and puts
 * the saved version beside it, which is what `EDIT_UPDATE_MESSAGES.conflict`
 * promises; saving again then replaces that version deliberately.
 */
export function ReportingEntryCard({ entry, meta, canEdit, tag, onSaved }: ReportingEntryCardProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.body);
  const [draftVersion, setDraftVersion] = useState(entry.version);
  const [conflict, setConflict] = useState<ReportingEntryView | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  const open = () => {
    setDraft(entry.body);
    setDraftVersion(entry.version);
    setConflict(null);
    setError("");
    setEditing(true);
  };
  const close = () => {
    setEditing(false);
    setConflict(null);
    setError("");
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!validUpdateBody(draft)) return;
    start(async () => {
      setError("");
      let result;
      try {
        result = await editReportingUpdate({
          entryId: entry.id,
          body: draft,
          visibility: entry.visibility,
          expectedVersion: conflict ? conflict.version : draftVersion,
        });
      } catch {
        setError("The update could not be saved. Your text is kept. Try again.");
        return;
      }
      if (result.ok) {
        onSaved(result.entry);
        close();
        router.refresh();
        return;
      }
      setError(result.error);
      if (result.reason === "conflict") setConflict(result.current);
    });
  };

  return (
    <article className={styles.card}>
      {!editing && (
        <>
          <p className={styles.body}>{entry.body}</p>
          <p className={styles.meta}>
            <span>{meta}</span>
            {tag}
            {canEdit && <button type="button" className={styles.edit} onClick={open}>Edit</button>}
          </p>
        </>
      )}
      {editing && (
        <form className={styles.form} onSubmit={submit}>
          <UpdateTextarea
            className={styles.textarea}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={5}
            aria-label="Edit update"
          />
          {conflict && (
            <div className={styles.conflict} aria-live="polite">
              <p className={styles.conflictLabel}>Saved right now</p>
              <p className={styles.conflictBody}>{conflict.body}</p>
              <p className={styles.conflictMeta}>{conflictMeta(meta, conflict)}</p>
            </div>
          )}
          {error && <p role="alert" className={styles.alert}>{error}</p>}
          <div className={styles.actions}>
            <button type="submit" className={styles.save} disabled={!validUpdateBody(draft) || pending}>{conflict ? "Save my text anyway" : "Save"}</button>
            <button type="button" className={styles.cancel} disabled={pending} onClick={close}>Cancel</button>
          </div>
        </form>
      )}
    </article>
  );
}
