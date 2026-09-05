import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { IconArrowLeft, IconArrowRight } from "symbols-react";
import { COLOSSEUM_SIGNUP_URL } from "@/lib/colosseum";
import styles from "./start.module.css";

export const metadata: Metadata = {
  title: "Choose your path to Colosseum",
  description:
    "Get help registering for the hackathon or head straight to Colosseum.",
  alternates: { canonical: "/colosseum/start" },
};

export default function ColosseumStartPage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Superteam NL home">
          <Image
            src="/landing/st-orange.png"
            width={2154}
            height={2116}
            sizes="30px"
            alt=""
          />
          <span>superteam NL</span>
        </Link>
        <Link href="/colosseum" className={styles.back}>
          <IconArrowLeft width={18} height={18} fill="currentColor" aria-hidden="true" />
          Back
        </Link>
      </header>

      <main className={styles.choices}>
        <div className={styles.question}>
          <h1>Which one are <em>you</em>?</h1>
        </div>

        <Link
          href="/colosseum/start/beginner"
          className={`${styles.choice} ${styles.beginner}`}
          aria-labelledby="beginner-title"
          aria-describedby="beginner-description"
        >
          <div className={styles.content}>
            <h2 id="beginner-title">Beginner</h2>
            <p id="beginner-description">
              First hackathon? We&apos;ll walk you through registration.
            </p>
            <span className={styles.action}>
              Start here
              <span className={styles.arrow} aria-hidden="true">
                <IconArrowRight width={20} height={20} fill="currentColor" />
              </span>
            </span>
          </div>
        </Link>

        <a
          href={COLOSSEUM_SIGNUP_URL}
          className={`${styles.choice} ${styles.experienced}`}
          aria-labelledby="experienced-title"
          aria-describedby="experienced-description"
        >
          <div className={styles.content}>
            <h2 id="experienced-title">Experienced</h2>
            <p id="experienced-description">
              You know the drill. Head straight to Colosseum and sign up.
            </p>
            <span className={styles.action}>
              Enter the arena
              <span className={styles.arrow} aria-hidden="true">
                <IconArrowRight width={20} height={20} fill="currentColor" />
              </span>
            </span>
          </div>
        </a>
      </main>
    </div>
  );
}
