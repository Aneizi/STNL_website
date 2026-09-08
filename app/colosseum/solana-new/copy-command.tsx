"use client";

import Image from "next/image";
import { useState } from "react";
import { SOLANA_NEW_INSTALL_COMMAND } from "@/lib/colosseum";
import styles from "./solana-new.module.css";

export function CopyCommand() {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(SOLANA_NEW_INSTALL_COMMAND);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className={styles.command}>
      <div className={styles.commandSurface}>
        <Image src="/colosseum/solana-new/install-command.svg" width={1124} height={148} alt="" className={styles.commandArtwork} unoptimized />
        <div className={styles.commandLive}>
          <div className={styles.commandHeader}>
            <span className={styles.commandDots} aria-hidden="true"><i /><i /><i /></span>
            <span>Install commands</span>
          </div>
          <pre><code>{SOLANA_NEW_INSTALL_COMMAND}</code></pre>
        </div>
        <code className={styles.accessibleCommand}>{SOLANA_NEW_INSTALL_COMMAND}</code>
        <button type="button" className={styles.copyButton} onClick={copy} aria-label="Copy install command" title="Copy install command">
          <Image src="/colosseum/solana-new/copy-icon.svg" width={23} height={23} alt="" unoptimized />
        </button>
      </div>
      <div className={styles.copyStatus} role="status">
        {status === "copied" && "Copied. Paste it into your terminal to install."}
        {status === "error" && (
          <>
            <p>Select and copy the command below.</p>
            <input aria-label="Solana.new install command" value={SOLANA_NEW_INSTALL_COMMAND} readOnly
              onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} />
          </>
        )}
      </div>
    </div>
  );
}
