import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowRight } from "symbols-react";
import { COLOSSEUM_SIGNUP_URL, COLOSSEUM_REGISTER_URL } from "@/lib/colosseum";
import { GuideShell, ExternalLink } from "../guide-shell";
import { BuildNotes } from "../build-notes";
import styles from "./beginner.module.css";

export const metadata: Metadata = {
  title: "The Beginner route",
  description: "Get started with Colosseum: register, find teammates, choose an idea, and build on Solana with Superteam NL.",
  alternates: { canonical: "/colosseum/start/beginner" },
};

export default function BeginnerPage() {
  return (
    <GuideShell>
      <h1>The Beginner route</h1>
      <p className={styles.introduction}>Four weeks to turn an idea into a working product, with other Dutch builders alongside you. Colosseum is online, from September 14 to October 12, 2026.</p>
      <p className={styles.introduction}>You can start without an idea or a team. Developers, designers, and people who understand a problem are all welcome.</p>
      <ol role="list" className={styles.steps}>
        <li>
          <span className={styles.number} aria-hidden="true">1</span>
          <div>
            <h2>Register your project on Colosseum</h2>
            <p>Create an account, then join the hackathon in Arena. An account alone does not register you. Set your country to <strong>Netherlands</strong> and include <strong>Solana</strong> in your selected chains if you&apos;re building on it.</p>
            <div className={styles.linkRow}>
              <ExternalLink href={COLOSSEUM_SIGNUP_URL}>Create an account</ExternalLink>
              <ExternalLink href={COLOSSEUM_REGISTER_URL}>Register for the hackathon</ExternalLink>
            </div>
          </div>
        </li>
        <li>
          <span className={styles.number} aria-hidden="true">2</span>
          <div>
            <h2>Import your project into the HQ</h2>
            <p>Log in to Superteam NL HQ to import your project from Colosseum.</p>
            <Link href="/hq/login" className={styles.externalLink}>
              Log in to HQ
              <IconArrowRight width={16} height={16} fill="currentColor" aria-hidden="true" />
            </Link>
          </div>
        </li>
      </ol>
      <section className={styles.nextStep} aria-labelledby="tools-title">
        <h2 id="tools-title">Add Solana to your AI workflow.</h2>
        <p>Solana.new bundles skills and tools for your coding assistant, from protocol integrations to testing and pitch preparation.</p>
        <Link href="/colosseum/solana-new?path=beginner" className={styles.externalLink}>
          Set up Solana.new
          <IconArrowRight width={16} height={16} fill="currentColor" aria-hidden="true" />
        </Link>
      </section>
      <BuildNotes />
    </GuideShell>
  );
}
