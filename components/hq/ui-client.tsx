"use client";

// Client-side companions to ui.tsx: shared pieces that carry state. Split
// from the style atoms because server components (dashboard) import those,
// and a module reachable from a Server Component may not import React hooks.
import { useEffect, useRef, useState } from "react";
import { IconDocumentOnClipboardFill } from "./icons/IconDocumentOnClipboardFill";

/**
 * "Saved" flash beside a heading — the only confirmation for controls that
 * save on change or blur. Shown solid, then fades: 1400ms + 600ms.
 */
export function useSavedFlash() {
  const [phase, setPhase] = useState<"hidden" | "shown" | "fading">("hidden");
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => {
    const list = timers.current;
    return () => list.forEach(clearTimeout);
  }, []);
  const flash = () => {
    timers.current.forEach(clearTimeout);
    setPhase("shown");
    timers.current = [
      setTimeout(() => setPhase("fading"), 1400),
      setTimeout(() => setPhase("hidden"), 2000),
    ];
  };
  return { phase, flash };
}

/**
 * Two-step delete, shared by every destructive control: the first click arms
 * the button ("Sure?"), the second performs. Two details that matter:
 *
 * - Auto-disarm after 4000ms — without it a mis-click leaves a primed button
 *   that deletes on the next stray click.
 * - stopPropagation on every handler, since most of these buttons sit inside
 *   clickable rows.
 *
 * Button chrome stays as it is per screen; only label, colour, and weight
 * come from here. `armed` is exposed for the one dark surface (Demo day
 * results) whose at-rest colour isn't a token.
 */
export function useConfirmDelete() {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return function armed(key: string, restLabel: string, perform: () => void) {
    const isArmed = armedKey === key;
    return {
      armed: isArmed,
      label: isArmed ? "Sure?" : restLabel,
      color: isArmed ? "var(--accent)" : "var(--label-3)",
      fontWeight: isArmed ? 600 : 400,
      title: isArmed ? "Click again to confirm" : "Delete",
      onClick: (e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (timer.current) clearTimeout(timer.current);
        if (isArmed) {
          setArmedKey(null);
          perform();
          return;
        }
        setArmedKey(key);
        timer.current = setTimeout(() => setArmedKey(null), 4000);
      },
    };
  };
}

/**
 * Copy-to-clipboard affordance beside a contact field. No border or fill —
 * it annotates the field, the way LumaMark annotates an event name. The
 * icon swaps to "Copied" for 1700ms to confirm the button actually pressed;
 * app-level toasts are a separate, additional signal.
 */
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onCopy = () => {
    if (value && navigator.clipboard) navigator.clipboard.writeText(value).catch(() => {});
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1700);
  };

  // The field beside it ellipsises, so the full address must be reachable
  // through the title/aria-label.
  return (
    <button
      className="hq-hover-accent"
      onClick={onCopy}
      title={`Copy ${value}`}
      aria-label={`Copy ${value}`}
      style={{
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        cursor: "pointer",
        background: "none",
        padding: "0 2px",
        color: copied ? "var(--green)" : "var(--label-2)",
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {copied ? (
        "Copied"
      ) : (
        <IconDocumentOnClipboardFill width={12} height={14.5} style={{ display: "block" }} />
      )}
    </button>
  );
}
