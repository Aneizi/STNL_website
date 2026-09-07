import Image from "next/image";
import Link from "next/link";
import { IconArrowLeft, IconArrowUpRight } from "symbols-react";
import styles from "./beginner/beginner.module.css";

export function GuideHeader({
  backHref = "/colosseum/start",
  backLabel = "Choose your path",
}: {
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <header className={styles.header}>
      <Link href="/" className={styles.brand} aria-label="Superteam NL home">
        <Image src="/landing/st-orange.png" width={2154} height={2116} sizes="30px" alt="" />
        <span>superteam NL</span>
      </Link>
      <Link href={backHref} className={styles.backLink}>
        <IconArrowLeft width={16} height={16} fill="currentColor" aria-hidden="true" />
        {backLabel}
      </Link>
    </header>
  );
}

export function GuideShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <GuideHeader />
      <main className={styles.guide}>{children}</main>
    </div>
  );
}

export function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={styles.externalLink}>
      {children}
      <IconArrowUpRight width={16} height={16} fill="currentColor" aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
