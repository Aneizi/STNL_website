"use client";

import { useEffect, useState } from "react";

// App-level transient message: one at a time, a new one replaces the old.
// A module-level listener (rather than context) lets any screen raise a
// toast without threading a provider through the tree — <HqToast /> renders
// exactly once, in app/hq/(app)/layout.tsx beside <HqChrome />.
let listener: ((message: string) => void) | null = null;

export function showToast(message: string) {
  listener?.(message);
}

/** How long the message stays at full opacity, and how long it takes to go. */
const HOLD_MS = 2000;
const EXIT_MS = 260;

export function HqToast() {
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  // Split from `toast` so the node can animate out before it unmounts: the
  // message is cleared only once the exit transition has finished.
  const [shown, setShown] = useState(false);

  useEffect(() => {
    listener = (message) => setToast({ id: Date.now(), message });
    return () => {
      listener = null;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    // One frame at the entry values first, so the transition has something
    // to move from — mounting straight into the shown state would snap.
    const enter = requestAnimationFrame(() => setShown(true));
    const hold = setTimeout(() => setShown(false), HOLD_MS);
    const clear = setTimeout(() => setToast(null), HOLD_MS + EXIT_MS);
    return () => {
      cancelAnimationFrame(enter);
      clearTimeout(hold);
      clearTimeout(clear);
    };
  }, [toast]);

  if (!toast) return null;
  return (
    // top:64 clears the 52px sticky chrome; zIndex:120 sits above modals
    // (100) and the activity drawer. Dark-on-light, matching the Demo day
    // results card — the only other inverted surface in HQ. A replacement
    // message reuses this node, so the text swaps without a re-entry.
    <div
      style={{
        position: "fixed",
        top: 64,
        left: "50%",
        zIndex: 120,
        background: "var(--label-1)",
        color: "var(--bg)",
        padding: "14px 24px",
        fontSize: 15,
        fontWeight: 600,
        letterSpacing: "0.01em",
        boxShadow: "var(--shadow-pop)",
        whiteSpace: "nowrap",
        maxWidth: "calc(100vw - 32px)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        opacity: shown ? 1 : 0,
        transform: `translateX(-50%) translateY(${shown ? 0 : -10}px) scale(${
          shown ? 1 : 0.94
        })`,
        transition: `opacity ${EXIT_MS}ms cubic-bezier(0.32, 0.72, 0, 1), transform ${EXIT_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
        pointerEvents: "none",
      }}
    >
      {toast.message}
    </div>
  );
}
