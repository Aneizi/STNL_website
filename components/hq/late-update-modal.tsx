'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { addReportingUpdate } from '@/lib/hq/actions/reporting';
import type { ReportingEntryView } from '@/lib/hq/reporting';
import type { TeamPeriodView } from '@/lib/hq/reporting-surface';
import { isWeekEnded, LATE_NOTE, periodRangeShortLabel } from '@/lib/hq/reporting-view';
import { validUpdateBody } from "@/lib/hq/reporting-body";
import { UpdateTextarea } from "./update-textarea";
import styles from './late-update-modal.module.css';
import { useModalFocus } from './use-modal-focus';

const SAVE_FAILED = 'The update could not be saved. Your text is kept. Try again.';

export type LateUpdateModalProps = {
  projectId: string;
  hackathonId: number;
  /** Every week of the edition, oldest first. Only ended weeks are offered. */
  periods: readonly TeamPeriodView[];
  /** The page's request instant, so the modal's week states agree with the kicker above it. */
  nowMs: number;
  onClose: () => void;
  /** The entry as saved; late updates never complete their week. */
  onSaved: (entry: ReportingEntryView, completesPeriod: boolean) => void;
};

/** Preselect the most recently ended week, so a late update lands on the week just missed. */
export function latestEndedPeriod(periods: readonly TeamPeriodView[], nowMs: number): TeamPeriodView | null {
  return [...periods].reverse().find(period => isWeekEnded(period, nowMs)) ?? null;
}

/**
 * "Missed a week's update?": one update added to a chosen week.
 *
 * The save carries `periodId` alone, never `expectedPeriodId`. The service
 * marks the entry late, which never completes or un-misses the week.
 * Current-week updates belong in the main composer.
 */
export function LateUpdateModal({ projectId, hackathonId, periods, nowMs, onClose, onSaved }: LateUpdateModalProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [periodId, setPeriodId] = useState<string | null>(() => latestEndedPeriod(periods, nowMs)?.periodId ?? null);
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const pastPeriods = periods.filter(period => isWeekEnded(period, nowMs));
  const ready = validUpdateBody(body) && pastPeriods.some(period => period.periodId === periodId);

  useModalFocus(dialogRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (periodId === null || !ready || pending) return;
    start(async () => {
      setError('');
      let result;
      try {
        result = await addReportingUpdate({ projectId, hackathonId, body, periodId });
      } catch {
        setError(SAVE_FAILED);
        return;
      }
      if (result.ok) {
        onSaved(result.entry, result.completesPeriod);
        router.refresh();
        onClose();
        return;
      }
      setError(result.error);
    });
  };

  return <div className={styles.overlay} onClick={onClose}>
    <div ref={dialogRef} tabIndex={-1} role='dialog' aria-modal='true' aria-labelledby='late-title' className={styles.dialog} onClick={event => event.stopPropagation()}>
      <p className={styles.kicker}>Late update</p>
      <h2 id='late-title' className={styles.title}>Which week?</h2>
      <form className={styles.form} onSubmit={submit} aria-busy={pending}>
        <div role='group' aria-label='Week' className={styles.weeks}>
          {pastPeriods.map(period => {
            const range = periodRangeShortLabel(period.startDate, period.endDate);
            return <button key={period.periodId} type='button' className={styles.week} aria-pressed={period.periodId === periodId} onClick={() => setPeriodId(period.periodId)}>
              <span className={styles.weekName}>Week {period.periodSequence}</span>
              <span className={styles.weekRange}>{range}</span>
            </button>;
          })}
        </div>
        <UpdateTextarea className={styles.textarea} value={body} onChange={event => setBody(event.target.value)} rows={5} aria-label='Your late update' placeholder='What moved, what was in the way, what came next.'/>
        <p className={styles.note}>{LATE_NOTE}</p>
        {error && <p role='alert' className={styles.alert}>{error}</p>}
        <div className={styles.actions}>
          <button type='submit' className={styles.submit} disabled={!ready || pending}>Add late update</button>
          <button type='button' className={styles.cancel} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  </div>;
}
