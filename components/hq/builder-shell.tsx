import Image from 'next/image';
import Link from 'next/link';
import { BuilderAccount, BuilderNav } from './builder-nav';
import styles from './builder-shell.module.css';

/**
 * The member page frame: brand, the capability-driven menu, the account
 * corner and the content column. The menu and the account come from the
 * member layout's provider; a page passes `back` only when it is a step in
 * a flow, since the menu's Home covers the rest.
 */
export function BuilderShell({children,wide=false,fullWidth=false,back}:{children:React.ReactNode;wide?:boolean;fullWidth?:boolean;back?:string}) {
  return <div className={`${styles.page} ${fullWidth?styles.workspacePage:''}`}>
    <header className={styles.header}>
      <Link className={styles.brand} href='/' aria-label='Superteam NL home'><Image src='/landing/st-orange.png' alt='' width={28} height={28}/><span>superteam NL</span></Link>
      <BuilderNav/>
      <BuilderAccount/>
    </header>
    <main className={`${styles.main} ${wide?styles.wide:''} ${fullWidth?styles.workspace:''}`}>
      {back&&<Link className={styles.back} href={back}>Back</Link>}
      {children}
    </main>
  </div>;
}
