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

export function HqToast() {
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);

  useEffect(() => {
    listener = (message) => setToast({ id: Date.now(), message });
    return () => {
      listener = null;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 1700);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;
  return (
    // key restarts the pop-in when a new message replaces a visible one.
    // top:64 clears the 52px sticky chrome; zIndex:120 sits above modals
    // (100) and the activity drawer. Dark-on-light, matching the Demo day
    // results card — the only other inverted surface in HQ.
    <div
      key={toast.id}
      className="hq-pop-in"
      style={{
        position: "fixed",
        top: 64,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 120,
        background: "var(--label-1)",
        color: "var(--bg)",
        padding: "8px 14px",
        fontSize: 12,
        fontWeight: 600,
        boxShadow: "var(--shadow-pop)",
        whiteSpace: "nowrap",
      }}
    >
      {toast.message}
    </div>
  );
}
