import Image from 'next/image';
import Link from 'next/link';
import { BuilderAccountMenu } from './builder-account-menu';
import styles from './builder-shell.module.css';

/**
 * The member page frame: the brand, the account corner and the content
 * column. The account corner reads the signed-in member's name from the
 * member layout's provider and renders nothing without one, so the pre-auth
 * screens and a signed-out invite page carry the brand alone.
 *
 * `back` is for a step in a flow (the onboarding pages). `bare` drops the
 * column altogether: no padding, no max-width and none of the column's
 * typography, only the focus ring, so a redesigned page (Home, Team,
 * Captains' Den, Account) lays itself out edge to edge below the header.
 * `back` has no effect under `bare`; such a page renders its own links.
 */
export function BuilderShell({children,back,bare=false,reminderPrompt=false}:{children:React.ReactNode;back?:string;bare?:boolean;reminderPrompt?:boolean}) {
  return <div className={styles.page}>
    <header className={styles.header}>
      <Link className={styles.brand} href='/hq/dashboard' aria-label='Superteam NL home'><Image src='/landing/st-orange.png' alt='' width={2154} height={2116} sizes='28px'/><span className={styles.brandName}>Superteam NL</span></Link>
      <BuilderAccountMenu reminderPrompt={reminderPrompt}/>
    </header>
    {bare
      ? <main className={styles.bare}>{children}</main>
      : <main className={styles.main}>
        {back&&<Link className={styles.back} href={back}>Back</Link>}
        {children}
      </main>}
  </div>;
}
