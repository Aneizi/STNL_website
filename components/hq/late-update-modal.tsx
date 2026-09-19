'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { addReportingUpdate } from '@/lib/hq/actions/reporting';
import type { ReportingEntryView } from '@/lib/hq/reporting';
import type { TeamPeriodView } from '@/lib/hq/reporting-surface';
import { isWeekCurrent, isWeekStarted, LATE_NOTE, periodRangeShortLabel } from '@/lib/hq/reporting-view';
import styles from './late-update-modal.module.css';
import { useModalFocus } from './use-modal-focus';

/** The same limit the service enforces (`MAX_BODY_LENGTH`), repeated here because that module is server only. */
const MAX_BODY = 4000;
const SAVE_FAILED = 'The update could not be saved. Your text is kept. Try again.';

export type LateUpdateModalProps = {
  projectId: string;
  hackathonId: number;
  /** Every week of the edition, oldest first. A week that has not started yet renders disabled. */
  periods: readonly TeamPeriodView[];
  /** The page's request instant, so the modal's week states agree with the kicker above it. */
  nowMs: number;
  onClose: () => void;
  /** The entry as saved, and whether it completed its week (only when the chosen week is the open one). */
  onSaved: (entry: ReportingEntryView, completesPeriod: boolean) => void;
};

/** The latest week that has started: preselected, so a late update lands on the week just missed unless another is chosen. */
export function latestStartedPeriod(periods: readonly TeamPeriodView[], nowMs: number): TeamPeriodView | null {
  return [...periods].reverse().find(period => isWeekStarted(period, nowMs)) ?? null;
}

/**
 * "Missed a week's update?": one update added to a chosen week.
 *
 * The save carries `periodId` alone, never `expectedPeriodId`. The service
 * marks the entry late once that week has ended, which never completes or
 * un-misses the week, and saves it as an ordinary update when the chosen
 * week is the one open now. A week that has not started is refused by the
 * service too; the disabled button only says so first.
 */
export function LateUpdateModal({ projectId, hackathonId, periods, nowMs, onClose, onSaved }: LateUpdateModalProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [periodId, setPeriodId] = useState<string | null>(() => latestStartedPeriod(periods, nowMs)?.periodId ?? null);
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const ready = Boolean(body.trim()) && periodId !== null;

  useModalFocus(dialogRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (periodId === null || !body.trim()) return;
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
          {periods.map(period => {
            const range = periodRangeShortLabel(period.startDate, period.endDate);
            return <button key={period.periodId} type='button' className={styles.week} disabled={!isWeekStarted(period, nowMs)} aria-pressed={period.periodId === periodId} onClick={() => setPeriodId(period.periodId)}>
              <span className={styles.weekName}>Week {period.periodSequence}</span>
              <span className={styles.weekRange}>{isWeekCurrent(period, nowMs) ? `${range}, current` : range}</span>
            </button>;
          })}
        </div>
        <textarea className={styles.textarea} value={body} onChange={event => setBody(event.target.value)} rows={5} maxLength={MAX_BODY} aria-label='Your late update' placeholder='What moved, what was in the way, what came next.'/>
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
