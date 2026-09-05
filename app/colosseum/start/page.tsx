import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { IconArrowLeft, IconArrowRight } from "symbols-react";
import styles from "./start.module.css";

export const metadata: Metadata = {
  title: "Choose your path to Colosseum",
  description:
    "Join the Dutch builders and find your path to the Colosseum hackathon.",
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
          href="/colosseum/start/interest?path=beginner"
          className={`${styles.choice} ${styles.beginner}`}
          aria-labelledby="beginner-title"
          aria-describedby="beginner-description"
        >
          <div className={styles.content}>
            <h2 id="beginner-title">Beginner</h2>
            <p id="beginner-description">
              First hackathon or don&apos;t feel confident yet?
            </p>
            <span className={styles.action}>
              Start here
              <span className={styles.arrow} aria-hidden="true">
                <IconArrowRight width={20} height={20} fill="currentColor" />
              </span>
            </span>
          </div>
        </Link>

        <Link
          href="/colosseum/start/interest?path=experienced"
          className={`${styles.choice} ${styles.experienced}`}
          aria-labelledby="experienced-title"
          aria-describedby="experienced-description"
        >
          <div className={styles.content}>
            <h2 id="experienced-title">Experienced</h2>
            <p id="experienced-description">
              You know the drill. Join the Dutch builders, then sign up.
            </p>
            <span className={styles.action}>
              Enter the arena
              <span className={styles.arrow} aria-hidden="true">
                <IconArrowRight width={20} height={20} fill="currentColor" />
              </span>
            </span>
          </div>
        </Link>
      </main>
    </div>
  );
}
