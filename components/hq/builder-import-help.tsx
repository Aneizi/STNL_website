'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { IconArrowRight } from 'symbols-react';
import { requestBuilderReview } from '@/lib/hq/actions/builders';
import styles from './builder-shell.module.css';

/**
 * The way in when Colosseum cannot return the project: a request that an
 * operator creates the team by hand. The link field is the page's own
 * (`url`/`onUrl`), so a link typed here is the one the page keeps. The
 * request confirms in place and the modal stays open; nothing navigates.
 */
export function BuilderImportHelp({ hackathonId, url, onUrl }: { hackathonId: number; url: string; onUrl: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <div className={styles.importHelpFooter}>
      <button type='button' className={styles.textButton} aria-haspopup='dialog' onClick={() => setOpen(true)}>Can’t find your project?</button>
    </div>
    {open && <ImportHelpDialog hackathonId={hackathonId} url={url} onUrl={onUrl} onClose={() => setOpen(false)}/>}
  </>;
}

function ImportHelpDialog({ hackathonId, url, onUrl, onClose }: {
  hackathonId: number;
  url: string;
  onUrl: (value: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const projectLinkRef = useRef<HTMLInputElement>(null);
  // Always asked for: the action keeps the account's own Telegram identity
  // when there is one and uses the typed handle only otherwise.
  const [telegramUsername, setTelegramUsername] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [usernameError, setUsernameError] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    projectLinkRef.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    start(async () => {
      setError('');
      setSent(false);
      setUsernameError(false);
      try {
        const result = await requestBuilderReview({ hackathonId, url, telegramUsername });
        if (result.ok) setSent(true);
        else {
          setError(result.error);
          if ('field' in result && result.field === 'telegramUsername') setUsernameError(true);
        }
      } catch {
        setError('We couldn’t send your request. Please try again.');
      }
    });
  }

  return <dialog ref={dialogRef} className={styles.importHelpDialog} aria-labelledby='import-help-title' aria-describedby='import-help-description'
    onClose={event => { if (!event.currentTarget.open) onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
    }}>
    <div className={styles.importHelpHeader}>
      <h2 id='import-help-title'>Request help</h2>
      <button type='button' className={styles.importHelpClose} aria-label='Close import help' onClick={() => dialogRef.current?.close()}><span aria-hidden='true'>×</span></button>
    </div>
    <p id='import-help-description'>If Colosseum can’t return your project yet, send us the link and your Telegram username. We’ll create your team in HQ by hand.</p>
    <form className={styles.form} onSubmit={submit} aria-busy={pending}>
      <label className={styles.field}>Colosseum project link
        <input ref={projectLinkRef} type='url' name='projectUrl' value={url} onChange={event => onUrl(event.target.value)} placeholder='https://colosseum.com/arena/projects/…' autoComplete='off' spellCheck={false} required maxLength={2048} disabled={pending}/>
      </label>
      <label className={styles.field}>Telegram username
        <input type='text' name='telegramUsername' value={telegramUsername} onChange={event => setTelegramUsername(event.target.value)} placeholder='@yourname' autoComplete='off' autoCapitalize='none' spellCheck={false} required maxLength={33} pattern='@?[A-Za-z0-9_]{1,32}' title='Enter your Telegram username, such as @yourname.' aria-invalid={usernameError || undefined} aria-describedby={usernameError ? 'import-help-error' : undefined} disabled={pending}/>
      </label>
      <button type='submit' className={styles.button} disabled={pending}>{sent ? 'Sent' : 'Send request'}<IconArrowRight width={20} height={20} fill='currentColor' aria-hidden='true'/></button>
      {error && <p id='import-help-error' className={styles.error} role='alert'>{error}</p>}
      {sent && <p className={styles.success} role='status'>Sent. We’ll be in touch on Telegram.</p>}
    </form>
  </dialog>;
}
