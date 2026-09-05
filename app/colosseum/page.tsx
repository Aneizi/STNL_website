import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { IconArrowRight } from "symbols-react";
import { ColosseumExperience, FairAnchor } from "./scroll-experience";
import styles from "./colosseum.module.css";

export const metadata: Metadata = {
  title: "Colosseum Hackathon",
  description:
    "Join Dutch builders at the Colosseum hackathon. September 14 to October 12, 2026.",
  alternates: { canonical: "/colosseum" },
  openGraph: {
    title: "Small Country. Serious Builders. | Superteam NL",
    description: "Colosseum hackathon. September 14 to October 12, 2026.",
    url: "/colosseum",
    images: [{
      url: "/ColosseumWorldsFairNL.jpg",
      width: 1254,
      height: 1254,
      alt: "Colosseum hackathon with Superteam Netherlands",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Small Country. Serious Builders. | Superteam NL",
    description: "Colosseum hackathon. September 14 to October 12, 2026.",
    images: ["/ColosseumWorldsFairNL.jpg"],
  },
};

export default function ColosseumPage() {
  return (
    <main className={styles.page}>
      <FairAnchor href="#fair-intro" className={styles.skipLink}>
        Skip to the introduction
      </FairAnchor>
      <ColosseumExperience className={styles.artwork}>
        <Image
          src="/ColosseumWorldsFairNL.jpg"
          alt="Colosseum hackathon, with Dutch canals, tulips and orange Superteam NL flags."
          width={1254}
          height={1254}
          sizes="100vw"
          quality={90}
          preload
          className={styles.poster}
        />
      </ColosseumExperience>
      <section id="fair-intro" tabIndex={-1} className={styles.intro} aria-labelledby="fair-title">
        <h1 id="fair-title">Small Country.<br /><em>Serious Builders.</em></h1>
        <p className={styles.date}>
          <time dateTime="2026-09-14">September 14</time>
          {" to "}
          <time dateTime="2026-10-12">October 12, 2026</time>
        </p>
        <Link href="/colosseum/start" className={styles.button}>
          I want to know more
          <IconArrowRight width={18} height={18} fill="currentColor" aria-hidden="true" />
        </Link>
      </section>
    </main>
  );
}
