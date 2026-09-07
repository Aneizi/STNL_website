"use client";

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
    <>
      <button
        type="button"
        className={styles.copyButton}
        onClick={copy}
        aria-label="Copy install command"
        title="Copy install command"
      />
      <div className={styles.copyStatus} role="status">
        {status === "copied" && "Copied. Paste it into your terminal to install."}
        {status === "error" && (
          <>
            <p>Select and copy the command below.</p>
            <input
              aria-label="Solana.new install command"
              value={SOLANA_NEW_INSTALL_COMMAND}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
            />
          </>
        )}
      </div>
    </>
  );
}
