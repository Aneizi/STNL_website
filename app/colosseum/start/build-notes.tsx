import Link from "next/link";
import { IconArrowRight } from "symbols-react";
import { COLOSSEUM_FAQ_URL, COLOSSEUM_SUBMISSION_GUIDE_URL } from "@/lib/colosseum";
import type { InterestPath } from "@/lib/colosseum-interest";
import { ExternalLink } from "./guide-shell";
import styles from "./beginner/beginner.module.css";

export function BuildNotes() {
  return (
    <section className={styles.notes} aria-labelledby="build-notes-title">
      <h2 id="build-notes-title">Make the four weeks count.</h2>
      <details>
        <summary>A simple build plan</summary>
        <ol className={styles.weekPlan}>
          <li><strong>Week 1: Build the core.</strong> Pick one user problem and get the main flow working.</li>
          <li><strong>Week 2: Test with people.</strong> Watch someone use it. Fix what gets in their way.</li>
          <li><strong>Week 3: Refine the product.</strong> Improve the demo and collect evidence of what users find useful.</li>
          <li><strong>Week 4: Prepare your submission.</strong> Record your pitch and demo, check access to every link, and submit early.</li>
        </ol>
      </details>
      <details>
        <summary>What to show the judges</summary>
        <p>Explain who needs your product, what you learned from them, and why your team can build it. Show the product working and how it could become a business.</p>
        <div className={styles.linkRow}>
          <ExternalLink href={COLOSSEUM_SUBMISSION_GUIDE_URL}>Colosseum&apos;s submission advice</ExternalLink>
          <ExternalLink href="https://x.com/JosipVolarevic2/status/2038643299221729462">Josip Volarević&apos;s Colosseum playbook</ExternalLink>
        </div>
      </details>
      <details>
        <summary>Before you submit</summary>
        <ul className={styles.checklist}>
          <li>Add every team member to the Colosseum project.</li>
          <li>Prepare a clear pitch and a separate technical demo. Check the current format and time limits in Arena.</li>
          <li>Make the app, videos, deck, and repository accessible to reviewers.</li>
          <li>Disclose work completed before the hackathon and identify what you built during it.</li>
        </ul>
        <p>Your team lead submits the project on Colosseum. Expressing interest with Superteam NL does not submit your project.</p>
        <ExternalLink href={COLOSSEUM_FAQ_URL}>Check the official requirements</ExternalLink>
      </details>
    </section>
  );
}

export function LocalSupport({ path }: { path: InterestPath }) {
  return (
    <aside className={styles.support} aria-labelledby="support-title">
      <h2 id="support-title">Build with the Dutch community.</h2>
      <p>Looking for a teammate, feedback on your idea, or help getting started? Leave your details so Superteam NL can get in touch.</p>
      <Link href={`/colosseum/start/interest?path=${path}`} className={styles.primaryLink}>
        Express your interest
        <IconArrowRight width={18} height={18} fill="currentColor" aria-hidden="true" />
      </Link>
    </aside>
  );
}
