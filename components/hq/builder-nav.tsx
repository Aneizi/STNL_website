'use client';
// The member menu and the account corner of the shell. The member layout
// derives the items once per request and provides them here; the shell each
// page renders reads them back. Layouts cannot pass data to their children
// and cannot read the pathname, so the provider carries the items and this
// client piece adds the current path.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext } from 'react';
import { isNavItemCurrent, type NavItem } from '@/lib/hq/member-nav';
import { BuilderSignOut } from './builder-sign-out';
import styles from './builder-shell.module.css';

/** What the shell shows for a signed-in member; null when there is none, so the pre-auth screens and a signed-out skeleton carry no menu. */
export type MemberNavState = { items: NavItem[]; account: { name: string } } | null;

const MemberNavContext = createContext<MemberNavState>(null);

export function MemberNavProvider({ value, children }: { value: MemberNavState; children: React.ReactNode }) {
  return <MemberNavContext.Provider value={value}>{children}</MemberNavContext.Provider>;
}

export function BuilderNav() {
  const nav = useContext(MemberNavContext);
  if (!nav?.items.length) return null;
  return <NavList items={nav.items} />;
}

/** Split out so the pathname hook runs only when there is a menu to place it on. */
function NavList({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return <nav className={styles.nav} aria-label='HQ navigation'>
    <ul className={styles.navList}>
      {items.map(item => {
        const current = isNavItemCurrent(item, pathname);
        return <li key={item.key}><Link href={item.href} aria-current={current ? 'page' : undefined}>{item.label}</Link></li>;
      })}
    </ul>
  </nav>;
}

export function BuilderAccount() {
  const nav = useContext(MemberNavContext);
  if (!nav) return null;
  const name = nav.account.name.trim();
  return <div className={styles.account}>
    {name && <span className={styles.accountName}>{name}</span>}
    <BuilderSignOut className={styles.signOut} />
  </div>;
}
