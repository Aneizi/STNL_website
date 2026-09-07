import Image from 'next/image';
import Link from 'next/link';
import styles from './builder-shell.module.css';

export function BuilderShell({children,wide=false,back='/hq/dashboard'}:{children:React.ReactNode;wide?:boolean;back?:string}) {
  return <div className={styles.page}>
    <header className={styles.header}>
      <Link className={styles.brand} href='/' aria-label='Superteam NL home'><Image src='/landing/st-orange.png' alt='' width={28} height={28}/><span>superteam NL</span></Link>
      <nav className={styles.nav} aria-label='HQ navigation'><Link href={back}>Back</Link><Link href='/hq/dashboard'>My HQ</Link></nav>
    </header>
    <main className={`${styles.main} ${wide?styles.wide:''}`}>{children}</main>
  </div>;
}
