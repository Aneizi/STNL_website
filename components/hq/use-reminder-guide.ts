'use client';

import { useCallback, useSyncExternalStore } from 'react';

type GuideStatus = 'new' | 'shown' | 'done';
const CHANGE = 'hq:reminder-guide';
const memory = new Map<string, GuideStatus>();

function read(key: string | null): GuideStatus {
  if (!key) return 'done';
  let stored: string | null = null;
  try { stored = window.localStorage.getItem(key); } catch { /* Browser storage may be unavailable. */ }
  return memory.get(key) ?? (stored === 'done' || stored === 'shown' ? stored : 'new');
}

function remember(key: string | null, status: GuideStatus) {
  if (!key || read(key) === 'done') return;
  memory.set(key, status);
  try { window.localStorage.setItem(key, status); } catch { /* Keep the current visit working without storage. */ }
  window.dispatchEvent(new Event(CHANGE));
}

function subscribe(notify: () => void) {
  const changed = (event: Event) => {
    if (event instanceof StorageEvent) {
      if (event.key) memory.delete(event.key);
      else memory.clear();
    }
    notify();
  };
  window.addEventListener('storage', changed);
  window.addEventListener(CHANGE, changed);
  return () => {
    window.removeEventListener('storage', changed);
    window.removeEventListener(CHANGE, changed);
  };
}

/** Persist each step per account in this browser, including whether its one bounce has played. */
export function useReminderGuide(userId: string | undefined, step: 'account' | 'reminders') {
  const key = userId ? `hq.telegram-guide.v1.${userId}.${step}` : null;
  const snapshot = useCallback(() => read(key), [key]);
  // Wait for the browser snapshot so returning users never see a completed prompt flash during hydration.
  const status = useSyncExternalStore(subscribe, snapshot, () => 'done' as const);
  const dismiss = useCallback(() => remember(key, 'done'), [key]);
  const finishBounce = useCallback(() => remember(key, 'shown'), [key]);
  return { visible: status !== 'done', animate: status === 'new', dismiss, finishBounce };
}
