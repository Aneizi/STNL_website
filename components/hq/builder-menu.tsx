import Link from 'next/link';
import { IconArrowRight } from 'symbols-react';
import styles from './builder-menu.module.css';

export function MenuGrid({ children, label = 'Home menu' }: { children: React.ReactNode; label?: string }) {
  return <nav aria-label={label}><ul className={styles.grid}>{children}</ul></nav>;
}

export function MenuTile({ href, label, needsAttention = false, external = false }: {
  href: string;
  label: string;
  needsAttention?: boolean;
  external?: boolean;
}) {
  const content = <>
    <span className={styles.label}>{label}</span>
    <IconArrowRight className={styles.arrow} width={24} height={24} fill='currentColor' aria-hidden='true'/>
    {needsAttention && <span className={styles.attention} role='img' aria-label='Needs attention' title='Needs attention'/>}
  </>;
  return <li className={styles.item}>
    {external
      ? <a className={styles.tile} href={href} target='_blank' rel='noopener noreferrer'>{content}</a>
      : <Link className={styles.tile} href={href}>{content}</Link>}
  </li>;
}
