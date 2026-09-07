import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowRight } from "symbols-react";
import { COLOSSEUM_REGISTER_URL, COLOSSEUM_COPILOT_URL } from "@/lib/colosseum";
import { GuideShell, ExternalLink } from "../guide-shell";
import { BuildNotes, LocalSupport } from "../build-notes";
import styles from "../beginner/beginner.module.css";

export const metadata: Metadata = {
  title: "Build for the Netherlands | Colosseum",
  description: "Register under Netherlands, validate your idea, and prepare your Colosseum submission with Superteam NL.",
  alternates: { canonical: "/colosseum/start/experienced" },
};

export default function ExperiencedPage() {
  return (
    <GuideShell>
      <h1>Build for<br /><em>the Netherlands.</em></h1>
      <p className={styles.introduction}>September 14 to October 12, 2026. Get registered, focus your idea, and leave time for a strong submission.</p>
      <ol role="list" className={styles.steps}>
        <li>
          <span className={styles.number} aria-hidden="true">1</span>
          <div>
            <h2>Register under Netherlands</h2>
            <p>Join the hackathon in Arena, even if you already have an account. Check that your country is <strong>Netherlands</strong> and include <strong>Solana</strong> in your selected chains if you&apos;re building on it.</p>
            <ExternalLink href={COLOSSEUM_REGISTER_URL}>Register for the hackathon</ExternalLink>
          </div>
        </li>
        <li>
          <span className={styles.number} aria-hidden="true">2</span>
          <div>
            <h2>Set up your team</h2>
            <p>Keep your project and team details up to date on Colosseum. Make sure every team member is included in your submission.</p>
          </div>
        </li>
        <li>
          <span className={styles.number} aria-hidden="true">3</span>
          <div>
            <h2>Pressure-test the idea</h2>
            <p>Use Colosseum Copilot to research previous projects. Talk to potential users, identify what existing products miss, and narrow the scope to a demo that proves your approach.</p>
            <ExternalLink href={COLOSSEUM_COPILOT_URL}>Research with Copilot</ExternalLink>
          </div>
        </li>
      </ol>
      <section className={styles.nextStep} aria-labelledby="tools-title">
        <h2 id="tools-title">Add Solana to your AI workflow.</h2>
        <p>Solana.new bundles skills and tools for your coding assistant, from protocol integrations to testing and pitch preparation.</p>
        <Link href="/colosseum/solana-new?path=experienced" className={styles.externalLink}>
          Set up Solana.new
          <IconArrowRight width={16} height={16} fill="currentColor" aria-hidden="true" />
        </Link>
      </section>
      <BuildNotes />
      <LocalSupport path="experienced" />
    </GuideShell>
  );
}
