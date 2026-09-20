import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

import { useReminderGuide } from '@/components/hq/use-reminder-guide';

let user = 0;
let storage: Map<string, string>;
beforeEach(() => {
  user++;
  storage = new Map();
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    dispatchEvent: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());
const useGuide = (step: 'account' | 'reminders' = 'account') => useReminderGuide(`test-${user}`, step);

describe('the one-time reminder guide', () => {
  it('bounces once, remains still afterwards, and disappears when its step is completed', () => {
    expect(useGuide()).toMatchObject({ visible: true, animate: true });
    useGuide().finishBounce();
    expect(useGuide()).toMatchObject({ visible: true, animate: false });
    useGuide().dismiss();
    expect(useGuide()).toMatchObject({ visible: false, animate: false });
    useGuide().finishBounce();
    expect(useGuide().visible).toBe(false);
  });

  it('keeps the account and toggle steps independent and scopes completion to the user', () => {
    useGuide().dismiss();
    expect(useGuide('reminders')).toMatchObject({ visible: true, animate: true });
    expect(useReminderGuide(`another-${user}`, 'account').visible).toBe(true);
  });

  it('reads the saved completion on a later visit', () => {
    storage.set(`hq.telegram-guide.v1.test-${user}.account`, 'done');
    expect(useGuide()).toMatchObject({ visible: false, animate: false });
    storage.set(`hq.telegram-guide.v1.test-${user}.reminders`, 'shown');
    expect(useGuide('reminders')).toMatchObject({ visible: true, animate: false });
  });

  it('still dismisses during the visit if browser storage is unavailable', () => {
    vi.stubGlobal('window', { localStorage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }, dispatchEvent: vi.fn() });
    useGuide().dismiss();
    expect(useGuide().visible).toBe(false);
  });
});
