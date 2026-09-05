import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { IconArrowLeft, IconArrowUpRight } from "symbols-react";
import { COLOSSEUM_SIGNUP_URL, COLOSSEUM_REGISTER_URL, COLOSSEUM_PROFILES_URL } from "@/lib/colosseum";
import { LINKS } from "@/lib/links";
import styles from "./beginner.module.css";

export const metadata: Metadata = {
  title: "Register for the Colosseum hackathon",
  description: "Your first Colosseum hackathon: create an account, register under Netherlands, and create your team.",
  alternates: { canonical: "/colosseum/start/beginner" },
};

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={styles.externalLink}>
      {children}
      <IconArrowUpRight width={16} height={16} fill="currentColor" aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export default function BeginnerPage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Superteam NL home">
          <Image src="/landing/st-orange.png" width={2154} height={2116} sizes="30px" alt="" />
          <span>superteam NL</span>
        </Link>
        <Link href="/colosseum/start" className={styles.backLink}>
          <IconArrowLeft width={16} height={16} fill="currentColor" aria-hidden="true" />
          Choose your path
        </Link>
      </header>
      <main className={styles.guide}>
        <h1>Join the<br /><em>hackathon.</em></h1>
        <p className={styles.introduction}>Your first hackathon starts here.</p>
        <ol role="list" className={styles.steps}>
          <li>
            <span className={styles.number} aria-hidden="true">1</span>
            <div>
              <h2>Create your account</h2>
              <p>Sign up on Colosseum with email, Google or GitHub.</p>
              <ExternalLink href={COLOSSEUM_SIGNUP_URL}>Create an account</ExternalLink>
            </div>
          </li>
          <li>
            <span className={styles.number} aria-hidden="true">2</span>
            <div>
              <h2>Register for the competition</h2>
              <p>Choose the hackathon in the Arena. Register under <strong>Netherlands</strong> to represent the Dutch community. Select up to <strong>3 chains</strong>, including Solana.</p>
              <ExternalLink href={COLOSSEUM_REGISTER_URL}>Register for the hackathon</ExternalLink>
            </div>
          </li>
          <li>
            <span className={styles.number} aria-hidden="true">3</span>
            <div>
              <h2>Create your team</h2>
              <p>Set up your team on Colosseum before joining the Superteam NL side track.</p>
              <ExternalLink href={COLOSSEUM_PROFILES_URL}>Find teammates</ExternalLink>
            </div>
          </li>
        </ol>
        <aside className={styles.support} aria-labelledby="support-title">
          <h2 id="support-title">Need a hand?</h2>
          <p>Bring your Colosseum team link to Superteam NL for local support.</p>
          <ExternalLink href={LINKS.telegram}>Talk to Superteam NL</ExternalLink>
        </aside>
      </main>
    </div>
  );
}
