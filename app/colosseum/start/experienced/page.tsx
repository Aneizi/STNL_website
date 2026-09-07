import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { IconArrowLeft, IconArrowRight, IconArrowUpRight } from "symbols-react";
import { COLOSSEUM_REGISTER_URL, COLOSSEUM_SIGNUP_URL } from "@/lib/colosseum";
import styles from "../beginner/beginner.module.css";

export const metadata: Metadata = {
  title: "Build for the Netherlands | Colosseum",
  description: "Register for the Colosseum hackathon under Netherlands, then initialize your team in Superteam NL HQ by importing your Colosseum project.",
  alternates: { canonical: "/colosseum/start/experienced" },
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

export default function ExperiencedPage() {
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
        <h1>Build for<br /><em>the Netherlands.</em></h1>
        <p className={styles.introduction}>Register on Colosseum. Fly the Superteam NL banner for better exposure.</p>
        <ol role="list" className={styles.steps}>
          <li>
            <span className={styles.number} aria-hidden="true">1</span>
            <div>
              <h2>Register under Netherlands</h2>
              <p>Open the hackathon in the Arena and set your country to <strong>Netherlands</strong>. Check this even if you already have a Colosseum account. Select up to <strong>3 chains</strong>, including Solana.</p>
              <ExternalLink href={COLOSSEUM_REGISTER_URL}>Register for the hackathon</ExternalLink>
              <p>New to Colosseum? <ExternalLink href={COLOSSEUM_SIGNUP_URL}>Create a Colosseum account</ExternalLink></p>
            </div>
          </li>
          <li>
            <span className={styles.number} aria-hidden="true">2</span>
            <div>
              <h2>Set up your team on Colosseum</h2>
              <p>Keep your project details and team members on Colosseum. HQ imports that project, so everyone joining your HQ team must be listed there.</p>
            </div>
          </li>
          <li>
            <span className={styles.number} aria-hidden="true">3</span>
            <div>
              <h2>Initialize your team in HQ</h2>
              <p>Create your HQ account now. When Colosseum opens project access at the start of the hackathon, paste your project link to import and verify your team.</p>
              <p>Already have an HQ team invitation? Use its code to join.</p>
              <Link href="/hq/signup?next=%2Fhq%2Fwelcome" className={styles.primaryLink}>
                Create your HQ account
                <IconArrowRight width={20} height={20} fill="currentColor" aria-hidden="true" />
              </Link>
            </div>
          </li>
        </ol>
      </main>
    </div>
  );
}
