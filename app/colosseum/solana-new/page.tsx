import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { IconArrowLeft } from "symbols-react";
import { SOLANA_NEW_URL } from "@/lib/colosseum";
import { getInterestDestination } from "@/lib/colosseum-interest";
import { CopyCommand } from "./copy-command";
import styles from "./solana-new.module.css";

export const metadata: Metadata = {
  title: "Ship on Solana | Solana.new",
  description: "Find an idea, use the AI tools you already have, and build on Solana with Solana.new.",
  alternates: { canonical: "/colosseum/solana-new" },
};

const assets = "/colosseum/solana-new";
const stages = [
  { id: "idea", title: "Idea", titleWidth: 105, description: "Pick from 500+ curated ideas or generate your own.", width: 640, height: 670 },
  { id: "build", title: "Build", titleWidth: 137, description: "AI writes and tests your app, using integrations like Jupiter and Helius.", width: 640, height: 576 },
  { id: "launch", title: "Launch", titleWidth: 194, description: "Get feedback, then generate marketing copy and GTM content.", width: 640, height: 598 },
  { id: "raise", title: "Raise", titleWidth: 132, description: "Get a market analysis and an investor-ready pitch deck.", width: 640, height: 631 },
];

function Emblem() {
  return <Image src={`${assets}/emblem.svg`} width={80} height={80} alt="" className={styles.emblem} unoptimized />;
}

export default async function SolanaNewPage({ searchParams }: {
  searchParams: Promise<{ path?: string | string[] }>;
}) {
  const params = await searchParams;
  const path = params.path === "experienced" ? "experienced" : "beginner";

  return (
    <main className={styles.page}>
      <nav className={styles.navigation} aria-label="Guide navigation">
        <Link href={getInterestDestination(path)} className={styles.backLink}>
          <IconArrowLeft width={18} height={18} fill="currentColor" aria-hidden="true" />
          Back to guide
        </Link>
      </nav>
      {/* Desktop positions follow the supplied 1920px Figma frame. The same sections reflow on smaller screens. */}
      <div className={styles.content}>
        <section className={styles.hero} aria-labelledby="solana-new-title">
          <div className={styles.heroCopy}>
            <h1 id="solana-new-title" className={styles.heroTitle}>
              <Image src={`${assets}/hero-title.svg`} width={850} height={210} alt="Not sure what to build on Solana?" preload unoptimized />
            </h1>
            <p>Pick from 500+ curated ideas or let AI generate a fresh one tailored to what you want to build.</p>
          </div>
          <Image src={`${assets}/hero-art.svg`} width={1065} height={760} alt="" className={styles.heroArt} preload unoptimized />
        </section>

        <section className={styles.ship} aria-labelledby="ship-title">
          <div className={styles.decoratedHeading}>
            <Emblem />
            <h2 id="ship-title" className={styles.shipTitle}>
              <Image src={`${assets}/ship-title.svg`} width={794} height={126} alt="Ship on Solana" unoptimized />
            </h2>
            <Emblem />
          </div>
        </section>

        <section className={styles.tools} aria-labelledby="tools-title">
          <div className={styles.toolsCopy}>
            <h2 id="tools-title" className={styles.toolsTitle}>
              <Image src={`${assets}/tools-title.svg`} width={1002} height={184} alt="Got a Claude or ChatGPT subscription?" unoptimized />
            </h2>
            <p>Use it with the AI tools you already have.<br className={styles.desktopBreak} /> Claude Code or Codex all work out of the box.</p>
          </div>
          <Image src={`${assets}/tools-art.svg`} width={686} height={660} alt="" className={styles.toolsArt} unoptimized />
        </section>

        <section className={styles.install} aria-labelledby="install-title">
          <h2 id="install-title" className={styles.installTitle}>
            <Image src={`${assets}/cli-title.svg`} width={516} height={80} alt="One CLI, 100+" className={styles.cliTitle} unoptimized />
            <Image src={`${assets}/superpowers-title.svg`} width={900} height={80} alt="Solana superpowers" className={styles.superpowersTitle} unoptimized />
          </h2>
          <p>Installs Solana skills, MCPs, and CLIs into your AI<br className={styles.desktopBreak} /> assistant. So it already knows how to build on Solana.</p>
          <CopyCommand />
        </section>

        <section className={styles.journey} aria-labelledby="journey-title">
          <h2 id="journey-title" className={styles.journeyTitle}>
            <Image src={`${assets}/steps-start.svg`} width={832} height={75} alt="From idea to launch," className={styles.stepsStart} unoptimized />
            <Image src={`${assets}/steps-end.svg`} width={524} height={75} alt="in four steps" className={styles.stepsEnd} unoptimized />
          </h2>
          <div className={styles.cardFrame}>
            <ol className={styles.cards}>
              {stages.map((stage) => (
                <li key={stage.id} className={`${styles.card} ${styles[stage.id]}`}>
                  <h3><Image src={`${assets}/${stage.id}-title.svg`} width={stage.titleWidth} height={49} alt={stage.title} unoptimized /></h3>
                  <p>{stage.description}</p>
                  <Image src={`${assets}/${stage.id}.webp`} width={stage.width} height={stage.height} alt="" className={styles.cardArt} unoptimized />
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className={styles.further} aria-labelledby="further-title">
          <div className={styles.decoratedHeading}>
            <Emblem />
            <h2 id="further-title" className={styles.furtherTitle}>
              <Image src={`${assets}/further-title.svg`} width={540} height={126} alt="Go further" unoptimized />
            </h2>
            <Emblem />
          </div>
          <p>Browse skills, contribute on GitHub, or join the community.</p>
          <a href={SOLANA_NEW_URL} className={styles.goLink}>
            <Image src={`${assets}/flare.svg`} width={16} height={16} alt="" unoptimized />
            Solana.new
            <Image src={`${assets}/flare.svg`} width={16} height={16} alt="" unoptimized />
          </a>
        </section>
      </div>
    </main>
  );
}
