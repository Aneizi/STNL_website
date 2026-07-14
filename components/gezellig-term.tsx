"use client";

import { useEffect, useState } from "react";

/**
 * The highlighted Dutch word in the About headline, with its definition in a
 * hover/focus tooltip. Client component so the tooltip meets WCAG 1.4.13:
 * Escape dismisses it, and the bubble (plus an invisible bridge over the
 * 12px lift gap) stays open while hovered.
 */
export function GezelligTerm() {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const shownClasses = dismissed
    ? ""
    : " group-hover:pointer-events-auto group-hover:-translate-y-3 group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:-translate-y-3 group-focus-visible:opacity-100";

  return (
    <em
      lang="nl"
      className="group relative cursor-help text-orange focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange focus-visible:ring-offset-4 focus-visible:ring-offset-cream"
      tabIndex={0}
      aria-describedby="gezellig-definition"
      onBlur={() => setDismissed(false)}
      onMouseLeave={() => setDismissed(false)}
    >
      gezellig
      <span
        role="tooltip"
        id="gezellig-definition"
        aria-hidden="true"
        className={
          "pointer-events-none absolute bottom-full left-1/2 w-max max-w-[min(84vw,26rem)] -translate-x-1/2 -translate-y-1.5 rounded-[14px] bg-ink px-[18px] py-3 text-center font-sans text-[15px]/[1.45] font-normal not-italic tracking-normal text-cream opacity-0 shadow-[0_6px_24px_rgba(22,19,15,0.18)] transition-[opacity,translate] duration-200 after:absolute after:inset-x-0 after:top-full after:h-3.5 after:content-['']" +
          shownClasses
        }
      >
        <em lang="nl" className="italic text-orange">
          gezellig
        </em>{" "}
        <span className="text-cream/50">/ adj. /</span> friendly ambience and
        cozy atmosphere
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-full -translate-x-1/2 border-x-[7px] border-t-[7px] border-x-transparent border-t-ink"
        />
      </span>
    </em>
  );
}
