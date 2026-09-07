import type { Metadata } from "next";
import Link from "next/link";
import { IconArrowRight } from "symbols-react";
import { COLOSSEUM_SIGNUP_URL, COLOSSEUM_REGISTER_URL, COLOSSEUM_PROFILES_URL, COLOSSEUM_COPILOT_URL } from "@/lib/colosseum";
import { GuideShell, ExternalLink } from "../guide-shell";
import { BuildNotes, LocalSupport } from "../build-notes";
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
            <h2>Register on Colosseum</h2>
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
            <h2>Find your people</h2>
            <p>You can enter solo or team up. Look for complementary skills: someone to build, someone to talk to users, someone to make the product easy to use.</p>
            <p>Keep your project and team members on Colosseum. You can import the project into Superteam NL HQ when project access opens.</p>
            <ExternalLink href={COLOSSEUM_PROFILES_URL}>Find teammates</ExternalLink>
          </div>
        </li>
        <li>
          <span className={styles.number} aria-hidden="true">3</span>
          <div>
            <h2>Choose one problem</h2>
            <p>Start with someone you can talk to and a problem they already have. Ask how they solve it today. Use Colosseum Copilot to explore similar projects, then decide what yours would do better.</p>
            <ExternalLink href={COLOSSEUM_COPILOT_URL}>Explore ideas with Copilot</ExternalLink>
          </div>
        </li>
        <li>
          <span className={styles.number} aria-hidden="true">4</span>
          <div>
            <h2>Build something you can show</h2>
            <p>Focus on one useful flow. Solana.new gives your AI coding assistant Solana tools and guidance to help you build it. Test the result with real people as you go.</p>
            <Link href="/colosseum/solana-new?path=beginner" className={styles.externalLink}>
              Get started with Solana.new
              <IconArrowRight width={16} height={16} fill="currentColor" aria-hidden="true" />
            </Link>
          </div>
        </li>
      </ol>
      <BuildNotes />
      <LocalSupport path="beginner" />
    </GuideShell>
  );
}
