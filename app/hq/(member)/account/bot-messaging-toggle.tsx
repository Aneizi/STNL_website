"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import styles from "@/components/hq/builder-shell.module.css";
import { setBotMessaging } from "@/lib/hq/actions/telegram";
import { telegramErrorMessage } from "../telegram-copy";

type Props = { enabled: boolean };

/**
 * The one control for bot messages. Flipping it runs the server action and
 * re-renders the page, whose status pill and copy come from the stored row,
 * not from this component's idea of what happened.
 */
export function BotMessagingToggle({ enabled }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");

  const toggle = () => start(async () => {
    setError("");
    try {
      const result = await setBotMessaging(!enabled);
      if (!result.ok) return setError(telegramErrorMessage(result.code) ?? "We could not save this. Please try again.");
      router.refresh();
    } catch {
      setError("We could not connect. Check your connection and try again.");
    }
  });

  return (
    <div className={styles.actions}>
      <button type="button" className={styles.secondary} disabled={pending} onClick={toggle}>
        {enabled ? "Disable bot messages" : "Enable bot messages"}
      </button>
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div>
  );
}
