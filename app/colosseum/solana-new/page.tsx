import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { IconArrowLeft } from "symbols-react";
import { SOLANA_NEW_INSTALL_COMMAND, SOLANA_NEW_URL } from "@/lib/colosseum";
import { getInterestDestination } from "@/lib/colosseum-interest";
import { CopyCommand } from "./copy-command";
import styles from "./solana-new.module.css";

export const metadata: Metadata = {
  title: "Ship on Solana | Solana.new",
  description: "A quick guide to building your first crypto app with solana.new. Install in one command, then go from idea to launch in four steps.",
  alternates: { canonical: "/colosseum/solana-new" },
};

export default async function SolanaNewPage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string | string[] }>;
}) {
  const params = await searchParams;
  const path = params.path === "experienced" ? "experienced" : "beginner";

  return (
    <main className={styles.page} aria-labelledby="solana-new-title">
      <nav className={styles.navigation} aria-label="Guide navigation">
        <Link href={getInterestDestination(path)} className={styles.backLink}>
          <IconArrowLeft width={18} height={18} fill="currentColor" aria-hidden="true" />
          Back to guide
        </Link>
      </nav>
      <div className={styles.artwork}>
        {/* Original Figma export. Its outlined type preserves the supplied fonts exactly. */}
        <Image
          src="/colosseum/solana-new/figma-page.svg"
          width={1795}
          height={3285}
          alt=""
          className={styles.design}
          preload
          unoptimized
        />
        {/* The export outlines its text, so provide the same content as semantic HTML. */}
        <div className="sr-only">
          <h1 id="solana-new-title">Ship on Solana</h1>
          <p>Idea to Launch</p>
          <p>A quick guide to building your first crypto app with solana.new.</p>
          <h2>One CLI, 100+ Solana superpowers</h2>
          <p>Installs Solana skills, MCPs, and CLIs into your AI assistant. So it already knows how to build on Solana.</p>
          <h3>Install commands</h3>
          <pre><code>{SOLANA_NEW_INSTALL_COMMAND}</code></pre>
          <h2>Install in one command</h2>
          <p>Run the setup script in your terminal to load everything into your AI assistant.</p>
          <h2>From idea to launch, in four steps</h2>
          <ol>
            <li><h3>Idea</h3><p>Pick from 500+ curated ideas or generate your own.</p></li>
            <li><h3>Build</h3><p>AI writes and tests your app, using integrations like Jupiter and Helius.</p></li>
            <li><h3>Launch</h3><p>Get feedback, then generate marketing copy and GTM content.</p></li>
            <li><h3>Raise</h3><p>Get a market analysis and an investor-ready pitch deck.</p></li>
          </ol>
        </div>
        <a href={SOLANA_NEW_URL} className={styles.siteLink} aria-label="Visit solana.new" />
        <CopyCommand />
      </div>
    </main>
  );
}
