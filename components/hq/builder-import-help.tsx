'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { requestBuilderReview } from '@/lib/hq/actions/builders';
import styles from './builder-shell.module.css';

export function BuilderImportHelp({ hackathonId, projectUrl, telegramConnected, disabled }: {
  hackathonId: number;
  projectUrl: string;
  telegramConnected: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <div className={styles.importHelpFooter}>
      <button type='button' className={styles.textButton} aria-haspopup='dialog' disabled={disabled} onClick={() => setOpen(true)}>
        Can’t import your project?
      </button>
    </div>
    {open && <ImportHelpDialog hackathonId={hackathonId} initialUrl={projectUrl} telegramConnected={telegramConnected} onClose={() => setOpen(false)}/>}
  </>;
}

function ImportHelpDialog({ hackathonId, initialUrl, telegramConnected, onClose }: {
  hackathonId: number;
  initialUrl: string;
  telegramConnected: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const projectLinkRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [telegramUsername, setTelegramUsername] = useState('');
  const [needsTelegramUsername, setNeedsTelegramUsername] = useState(!telegramConnected);
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
      setUsernameError(false);
      try {
        const result = await requestBuilderReview({ hackathonId, url, telegramUsername: needsTelegramUsername ? telegramUsername : undefined });
        if (result.ok) router.replace(result.data.url);
        else {
          setError(result.error);
          if ('field' in result && result.field === 'telegramUsername') {
            setNeedsTelegramUsername(true);
            setUsernameError(true);
          }
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
      <h2 id='import-help-title'>Let’s get your project in.</h2>
      <button type='button' className={styles.importHelpClose} aria-label='Close import help' onClick={() => dialogRef.current?.close()}><span aria-hidden='true'>×</span></button>
    </div>
    <p id='import-help-description'>Paste your project link and we’ll take a look.</p>
    <form className={styles.form} onSubmit={submit} aria-busy={pending}>
      <label className={styles.field}>Project link
        <input ref={projectLinkRef} type='url' name='projectUrl' value={url} onChange={event => setUrl(event.target.value)} placeholder='https://colosseum.com/arena/projects/…' autoComplete='url' spellCheck={false} required maxLength={2048} disabled={pending}/>
      </label>
      {needsTelegramUsername && <label className={styles.field}>Telegram username
        <input type='text' name='telegramUsername' value={telegramUsername} onChange={event => setTelegramUsername(event.target.value)} placeholder='@yourname' autoComplete='off' autoCapitalize='none' spellCheck={false} required maxLength={33} pattern='@?[A-Za-z0-9_]{1,32}' title='Enter your Telegram username, such as @yourname.' aria-invalid={usernameError || undefined} aria-describedby={usernameError ? 'import-help-error' : undefined} disabled={pending}/>
      </label>}
      {error && <p id='import-help-error' className={styles.error} role='alert'>{error}</p>}
      <button type='submit' className={styles.button} disabled={pending}>{pending ? 'Sending…' : 'Request help'}</button>
    </form>
  </dialog>;
}
