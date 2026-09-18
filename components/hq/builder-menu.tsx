'use client';
// Home's poster tiles: the hackathon, the Member Portal and the Captains'
// Den, each a 420px block with a kicker row on top and a serif title at the
// bottom. The two live tiles lift and tilt under a fine pointer; the two
// disabled states are plain blocks, so a tile that cannot be opened never
// answers the cursor. Client-side only for the tilt, which needs mouse
// events, matchMedia and requestAnimationFrame.
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { CAPTAIN_PATH } from '@/lib/hq/member-routes';
import { IconLockFill } from './icons/IconLockFill';
import { IconLockOpenFill } from './icons/IconLockOpenFill';
import styles from './builder-menu.module.css';

/** The hackathon's name, as every member screen writes it. */
const HACKATHON_NAME = "Crypto World's Fair";
/** The hackathon tile's subtitle once the account has a team, and while it has none. */
const HACKATHON_SUBTITLE = 'Colosseum Hackathon 2026';
const INITIALIZE_SUBTITLE = 'Link your Colosseum project to start';

/**
 * The Home tile's view of the account's team: where it opens, the week
 * label when a week is open (null keeps the kicker row empty), and whether
 * this week's update is still due.
 */
export type HomeTeam = { href: string; weekLabel: string | null; updateDue: boolean };

/** Only a hovering fine pointer on a wide enough screen, and never for someone who asked for less motion. */
const TILT_MEDIA = '(hover: hover) and (pointer: fine) and (min-width: 700px) and (prefers-reduced-motion: no-preference)';

/**
 * The hover tilt: the tile lifts 10px, comes 24px forward and rotates up to
 * 4 degrees towards the cursor, its shadow moving the other way. One frame
 * is queued per mouse move and the last one wins; leaving eases the tile
 * back over .7s. The styles are written straight onto the element rather
 * than through state, so a mouse move never re-renders the tile.
 */
function useTilt() {
  const frame = useRef<number | null>(null);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const onMouseMove = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!window.matchMedia(TILT_MEDIA).matches) return;
    const el = event.currentTarget;
    const rect = el.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - .5;
    const py = (event.clientY - rect.top) / rect.height - .5;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      el.style.transition = 'transform .12s ease-out, box-shadow .6s cubic-bezier(.22,1,.36,1)';
      el.style.transform = `translateY(-10px) translateZ(24px) rotateX(${(-py * 8).toFixed(2)}deg) rotateY(${(px * 8).toFixed(2)}deg)`;
      el.style.boxShadow = `${(-px * 24).toFixed(1)}px ${(28 - py * 12).toFixed(1)}px 56px rgba(22,19,15,.28), 0 6px 14px rgba(22,19,15,.12)`;
    });
  };
  const onMouseLeave = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const el = event.currentTarget;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    el.style.transition = 'transform .7s cubic-bezier(.22,1,.36,1), box-shadow .7s cubic-bezier(.22,1,.36,1)';
    el.style.transform = 'translateY(0) translateZ(0) rotateX(0) rotateY(0)';
    el.style.boxShadow = '0 0 0 rgba(22,19,15,0)';
  };
  return { onMouseMove, onMouseLeave };
}

export function MenuGrid({ children, label = 'Home menu' }: { children: React.ReactNode; label?: string }) {
  return <nav aria-label={label}><ul className={styles.grid}>{children}</ul></nav>;
}

function Title({ top, bottom }: { top: string; bottom: string }) {
  return <span className={styles.title}>{top}<br/>{bottom}</span>;
}

/** A tile without a subtitle keeps the line anyway, so the three titles sit at one height. */
function ReservedLine() {
  return <span className={styles.subReserve} aria-hidden='true'/>;
}

function UpdateDue() {
  return <span className={styles.due}><span className={styles.dot}/>Update due</span>;
}

/** The orange tile: the team's week and its page, or the invitation to initialize a team. */
export function HackathonTile({ team }: { team: HomeTeam | null }) {
  const tilt = useTilt();
  return <li className={styles.item3d}>
    <Link className={`${styles.tile} ${styles.live} ${styles.orange}`} href={team ? team.href : '/hq/initialize'} {...tilt}>
      <span className={`${styles.kicker} ${styles.kickerRow} ${styles.kickerWrap}`}>
        <span>{team ? team.weekLabel : HACKATHON_NAME}</span>
        {team?.updateDue && <UpdateDue/>}
      </span>
      <span className={styles.body}>
        {team ? <Title top='Crypto' bottom="World's Fair"/> : <Title top='Initialize' bottom='your team'/>}
        <span className={styles.sub}>{team ? HACKATHON_SUBTITLE : INITIALIZE_SUBTITLE}</span>
      </span>
    </Link>
  </li>;
}

/** The hatched tile: the Member Portal is not built yet, and the tile says so without being a link. */
export function PortalTile() {
  return <li className={styles.item}>
    <span aria-disabled='true' className={`${styles.tile} ${styles.hatched} ${styles.disabled}`}>
      <span className={styles.kicker}>Under construction</span>
      <span className={styles.body}>
        <Title top='Member' bottom='Portal'/>
        <ReservedLine/>
      </span>
    </span>
  </li>;
}

/**
 * The ink tile: open for a Captain, with this edition's assignment count,
 * and a closed padlock on a block that goes nowhere for everyone else. The
 * capability here is the session's, for presentation; the Den re-reads the
 * grant itself.
 */
export function CaptainTile({ captain, teamCount }: { captain: boolean; teamCount: number }) {
  const tilt = useTilt();
  const kicker = <span className={`${styles.kicker} ${styles.kickerRow}`}>
    <span>Captains only</span>
    {captain ? <IconLockOpenFill className={styles.icon} width={21} height={20}/> : <IconLockFill className={styles.icon} width={14} height={20}/>}
  </span>;
  const title = <Title top="Captains'" bottom='Den'/>;
  return <li className={styles.item3d}>
    {captain
      ? <Link className={`${styles.tile} ${styles.live} ${styles.ink}`} href={CAPTAIN_PATH} {...tilt}>
        {kicker}
        <span className={styles.body}>
          {title}
          <span className={`${styles.sub} ${styles.subFaded}`}>{`${teamCount} team${teamCount === 1 ? '' : 's'} assigned to you`}</span>
        </span>
      </Link>
      : <span aria-disabled='true' className={`${styles.tile} ${styles.ink} ${styles.disabled}`}>
        {kicker}
        <span className={styles.body}>
          {title}
          <ReservedLine/>
        </span>
      </span>}
  </li>;
}
