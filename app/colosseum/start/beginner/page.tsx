import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { IconArrowLeft, IconArrowRight, IconArrowUpRight } from "symbols-react";
import { COLOSSEUM_SIGNUP_URL, COLOSSEUM_REGISTER_URL, COLOSSEUM_PROFILES_URL } from "@/lib/colosseum";
import { LINKS } from "@/lib/links";
import styles from "./beginner.module.css";

export const metadata: Metadata = {
  title: "Register for the Colosseum hackathon",
  description: "Your first Colosseum hackathon: register under Netherlands, set up your team on Colosseum, and join Superteam NL HQ.",
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
              <h2>Register under Netherlands</h2>
              <p>Choose the hackathon in the Arena and set your country to <strong>Netherlands</strong>. This is how you represent the Dutch community. Select up to <strong>3 chains</strong>, including Solana.</p>
              <ExternalLink href={COLOSSEUM_REGISTER_URL}>Register for the hackathon</ExternalLink>
            </div>
          </li>
          <li>
            <span className={styles.number} aria-hidden="true">3</span>
            <div>
              <h2>Create your team on Colosseum</h2>
              <p>Your project and team live on Colosseum. You will import them into Superteam NL HQ when project access opens.</p>
              <ExternalLink href={COLOSSEUM_PROFILES_URL}>Find teammates</ExternalLink>
            </div>
          </li>
        </ol>
        <section className={styles.nextStep} aria-labelledby="hq-title">
          <h2 id="hq-title">Join Superteam NL HQ</h2>
          <p>Create your HQ account now. You can initialize your team by importing its Colosseum project link when project access opens at the start of the hackathon.</p>
          <p>No team yet? You can join one later or continue without building.</p>
          <Link href="/hq/signup?next=%2Fhq%2Fwelcome" className={styles.primaryLink}>
            Create your HQ account
            <IconArrowRight width={20} height={20} fill="currentColor" aria-hidden="true" />
          </Link>
        </section>
        <aside className={styles.support} aria-labelledby="support-title">
          <h2 id="support-title">Need a hand?</h2>
          <p>Get help registering or finding your next step.</p>
          <ExternalLink href={LINKS.telegram}>Talk to Superteam NL</ExternalLink>
        </aside>
      </main>
    </div>
  );
}
