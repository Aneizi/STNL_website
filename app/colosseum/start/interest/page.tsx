import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { IconArrowLeft } from "symbols-react";
import { InterestForm } from "./interest-form";
import styles from "./interest.module.css";

export const metadata: Metadata = {
  title: "Join the Dutch builders",
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
        <Link href="/colosseum/start" className={styles.back}>
          <IconArrowLeft width={18} height={18} fill="currentColor" aria-hidden="true" />
          Back
        </Link>
      </header>
      <main className={styles.main}>
        <h1>Count <em>me in.</em></h1>
        <p className={styles.introduction}>Join the Dutch builders taking on Colosseum.</p>
        <InterestForm key={path} path={path} />
      </main>
    </div>
  );
}
