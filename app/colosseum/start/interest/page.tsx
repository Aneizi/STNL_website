import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { IconArrowLeft } from "symbols-react";
import {
  getInterestDestination,
} from "@/lib/colosseum-interest";
import { SavedInterestForm } from "./saved-interest-form";
import styles from "./interest.module.css";

export const metadata: Metadata = {
  title: "Express your interest",
  description: "Express your interest in the Colosseum hackathon with Superteam NL.",
  alternates: { canonical: "/colosseum/start/interest" },
  robots: { index: false, follow: true },
};

export default async function InterestPage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string | string[] }>;
}) {
  const params = await searchParams;
  const path = params.path === "experienced" ? "experienced" : "beginner";

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Superteam NL home">
          <Image src="/landing/st-orange.png" width={2154} height={2116} sizes="30px" alt="" />
          <span>superteam NL</span>
        </Link>
        <Link href={getInterestDestination(path)} className={styles.back}>
          <IconArrowLeft width={18} height={18} fill="currentColor" aria-hidden="true" />
          Back to guide
        </Link>
      </header>
      <main className={styles.main}>
        <h1>Express <em>your interest.</em></h1>
        <p className={styles.introduction}>Leave your details so we can get in touch about the hackathon. You can express interest before you have an idea or a team.</p>
        <p className={styles.note}>This is for Superteam NL updates. Register for the hackathon separately on Colosseum.</p>
        <SavedInterestForm path={path} />
      </main>
    </div>
  );
}
