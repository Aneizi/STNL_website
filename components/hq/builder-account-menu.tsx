'use client';
// The account corner of the member header: a 44px initials avatar that opens
// a small menu with the member's name, Account and Sign out. The member
// layout provides the signed-in member's name once per request; the shell
// each page renders reads it back here. Layouts cannot pass data to their
// children, so the provider carries the name and this client piece owns the
// menu state.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { memberAuthClient } from '@/lib/hq/member-auth-client';
import styles from './builder-shell.module.css';

/** What the header shows for a signed-in member; null when there is none, including a visitor with only an operator session. */
export type MemberAccountState = { name: string } | null;

const MemberAccountContext = createContext<MemberAccountState>(null);

export function MemberAccountProvider({ value, children }: { value: MemberAccountState; children: React.ReactNode }) {
  return <MemberAccountContext.Provider value={value}>{children}</MemberAccountContext.Provider>;
}

/** The first letter of the first two words, upper-cased: "Nienke Visser" is NV, "Femke de Jong" is FD, a single word gives one letter and an empty name nothing. */
export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join('');
}

export const SIGN_OUT_FAILED = 'Could not sign out. Please try again.';

type AccountMenuProps = {
  name: string;
  reminderPrompt?: boolean;
  open: boolean;
  pending: boolean;
  error: string;
  onToggle: () => void;
  /** Closes without signing out: the Account item was chosen. */
  onClose: () => void;
  onSignOut: () => void;
  /** The wrapper, for the outside-click check; the avatar, so focus can return to it. */
  wrapperRef?: React.Ref<HTMLDivElement>;
  avatarRef?: React.Ref<HTMLButtonElement>;
};

/** The markup alone, with the state passed in, so a static render can check it. */
export function AccountMenu({ name, reminderPrompt = false, open, pending, error, onToggle, onClose, onSignOut, wrapperRef, avatarRef }: AccountMenuProps) {
  const shownName = name.trim();
  return <div className={styles.accountMenu} ref={wrapperRef}>
    {reminderPrompt && <button type='button' className={styles.reminderPrompt} onClick={onToggle} aria-expanded={open}>
      <span>Turn on Telegram reminders</span>
      <svg className={styles.reminderArrow} width='40' height='24' viewBox='0 0 40 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'><path d='M3 12h32m-9-8 9 8-9 8'/></svg>
    </button>}
    <button type='button' className={styles.avatar} aria-label='Account menu' aria-expanded={open} onClick={onToggle} ref={avatarRef}>{initials(shownName)}</button>
    {open && <div role='menu' className={styles.menu}>
      {shownName && <div className={styles.menuName}>{shownName}</div>}
      <Link href='/hq/account' role='menuitem' className={styles.menuItem} onClick={onClose}>{reminderPrompt ? 'Account & Telegram reminders' : 'Account'}</Link>
      <button type='button' role='menuitem' className={styles.menuItem} disabled={pending} onClick={onSignOut}>Sign out</button>
      {error && <p role='alert' className={styles.menuError}>{error}</p>}
    </div>}
  </div>;
}

export function BuilderAccountMenu({ reminderPrompt = false }: { reminderPrompt?: boolean }) {
  const account = useContext(MemberAccountContext);
  if (!account) return null;
  return <SignedInMenu name={account.name} reminderPrompt={reminderPrompt} />;
}

/** Split out so the hooks run only when there is a member to show. */
function SignedInMenu({ name, reminderPrompt }: { name: string; reminderPrompt: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // A click anywhere but the avatar or the menu closes it; Escape closes it
    // and hands focus back to the avatar. Both listen only while it is open.
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Node && wrapperRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      avatarRef.current?.focus();
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const signOut = async () => {
    setPending(true);
    setError('');
    let failed = false;
    try {
      failed = Boolean((await memberAuthClient.signOut()).error);
    } catch {
      // A request that never reached the server (offline, a dropped
      // connection) answers like a refused one, not as an unhandled
      // rejection that leaves the menu stuck on its pending state.
      failed = true;
    }
    if (failed) {
      // The menu stays open with the message, so the member can try again.
      setError(SIGN_OUT_FAILED);
      setPending(false);
      return;
    }
    router.replace('/hq/login');
    router.refresh();
  };

  return <AccountMenu
    name={name}
    reminderPrompt={reminderPrompt}
    open={open}
    pending={pending}
    error={error}
    onToggle={() => { setOpen((current) => !current); setError(''); }}
    onClose={() => setOpen(false)}
    onSignOut={signOut}
    wrapperRef={wrapperRef}
    avatarRef={avatarRef}
  />;
}
