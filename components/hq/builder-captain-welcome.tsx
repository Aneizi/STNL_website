'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { CAPTAIN_PATH } from '@/lib/hq/member-routes';
import { useModalFocus } from './use-modal-focus';
import styles from './builder-captain-welcome.module.css';

/** A one-time welcome after accepting Captain access, over the Home menu. */
export function BuilderCaptainWelcome() {
  const [open,setOpen]=useState(true);

  useEffect(()=>{
    // Consume the arrival marker without navigating or hiding the popup.
    // Refreshing or returning to this history entry then shows the menu alone.
    const url=new URL(window.location.href);
    if(url.searchParams.get('welcome')==='captain') {
      url.searchParams.delete('welcome');
      window.history.replaceState(window.history.state,'',`${url.pathname}${url.search}${url.hash}`);
    }
  },[]);

  return open?<CaptainWelcomeDialog onClose={()=>setOpen(false)}/>:null;
}

function CaptainWelcomeDialog({onClose}:{onClose:()=>void}) {
  const dialog=useRef<HTMLDivElement>(null);
  const [closing,setClosing]=useState(false);
  useModalFocus(dialog);

  useEffect(()=>{
    const timer=window.setTimeout(()=>setClosing(true),10_000);
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setClosing(true);};
    document.addEventListener('keydown',escape);
    return ()=>{window.clearTimeout(timer);document.removeEventListener('keydown',escape);};
  },[]);

  useEffect(()=>{
    if(!closing)return;
    const timer=window.setTimeout(onClose,200);
    return ()=>window.clearTimeout(timer);
  },[closing,onClose]);

  return <div className={`${styles.overlay} ${closing?styles.closing:''}`} onClick={()=>setClosing(true)}>
    <div ref={dialog} role='dialog' aria-modal='true' aria-labelledby='captain-welcome-title' aria-describedby='captain-welcome-description' tabIndex={-1} className={styles.dialog} onClick={event=>event.stopPropagation()}>
      <h2 id='captain-welcome-title' className={styles.title}>You&apos;re now a captain.</h2>
      <p id='captain-welcome-description' className={styles.description}>
        <Link href={CAPTAIN_PATH}>Go to the Captain&apos;s Den</Link>
      </p>
      <button type='button' className={styles.okay} onClick={()=>setClosing(true)}>Okay</button>
    </div>
  </div>;
}
