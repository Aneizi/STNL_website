'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { memberAuthClient } from '@/lib/hq/member-auth-client';
import styles from './builder-shell.module.css';
export function BuilderSignOut(){
  const router=useRouter();const[pending,setPending]=useState(false);const[error,setError]=useState('');
  return <><button className={styles.textButton} disabled={pending} onClick={async()=>{setPending(true);const result=await memberAuthClient.signOut();if(result.error){setError('Could not sign out. Please try again.');setPending(false);}else{router.replace('/hq/signin');router.refresh();}}}>Sign out</button>{error&&<p role='alert'>{error}</p>}</>;
}
