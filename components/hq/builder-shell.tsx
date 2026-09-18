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
 * `back` is for a step in a flow (the onboarding pages); `wide` and
 * `fullWidth` widen the column for the team pages. `bare` drops the column
 * altogether: no padding, no max-width and none of the column's typography,
 * only the focus ring, so a redesigned page (Home, Team, Captains' Den,
 * Account) lays itself out edge to edge below the header. `back`, `wide`
 * and `fullWidth` have no effect under `bare`; such a page renders its own
 * links.
 */
export function BuilderShell({children,wide=false,fullWidth=false,back,bare=false}:{children:React.ReactNode;wide?:boolean;fullWidth?:boolean;back?:string;bare?:boolean}) {
  return <div className={`${styles.page} ${fullWidth?styles.workspacePage:''}`}>
    <header className={styles.header}>
      <Link className={styles.brand} href='/hq/dashboard' aria-label='Superteam NL home'><Image src='/landing/st-orange.png' alt='' width={2154} height={2116} sizes='28px'/>Superteam NL</Link>
      <BuilderAccountMenu/>
    </header>
    {bare
      ? <main className={styles.bare}>{children}</main>
      : <main className={`${styles.main} ${wide?styles.wide:''} ${fullWidth?styles.workspace:''}`}>
        {back&&<Link className={styles.back} href={back}>Back</Link>}
        {children}
      </main>}
  </div>;
}
