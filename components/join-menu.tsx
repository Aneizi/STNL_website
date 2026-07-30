"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconChevronDown } from "symbols-react";
import { LINKS } from "@/lib/links";
import { SOCIAL_GLYPHS } from "@/lib/social-glyphs";

/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Join popover
 *
 *    0ms   card pops from under the button (scale .82 -> 1,
 *          4px drop-in, springy overshoot), chevron flips
 *   50ms   Telegram icon pops in (scale .5 -> 1)
 *  100ms   WhatsApp icon pops in
 *  270ms   idle
 *
 * Exit: card shrinks + fades in one quick 130ms ease-in beat.
 * Reduced motion: globals.css collapses all of it to instant.
 * ───────────────────────────────────────────────────────── */
const POP = {
  open: "duration-[220ms] ease-[cubic-bezier(.34,1.56,.64,1)]",
  close: "duration-[130ms] ease-in",
  iconDelays: ["delay-[50ms]", "delay-[100ms]"],
};

const CHANNELS = [
  { label: "Telegram", href: LINKS.telegram, ...SOCIAL_GLYPHS.telegram },
  { label: "WhatsApp", href: LINKS.whatsapp, ...SOCIAL_GLYPHS.whatsapp },
];

export function JoinMenu({
  className,
  align = "right",
  side = "bottom",
}: {
  /** Styles for the trigger, supplied by the host nav so it matches its siblings. */
  className: string;
  align?: "right" | "center";
  /** Open upward when the trigger sits near the viewport bottom (home hero nav). */
  side?: "bottom" | "top";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((o) => !o)}
        className={`uppercase ${className}`}
      >
        <span className="relative pr-[11px]">
          Join
          <IconChevronDown
            aria-hidden="true"
            fill="currentColor"
            className={`absolute right-0 top-1/2 h-[5px] w-2 -translate-y-1/2 transition-transform duration-200 ${
              (side === "top") !== open ? "rotate-180" : ""
            }`}
          />
        </span>
        <span className="sr-only"> community channels</span>
      </button>

      <div
        id={popoverId}
        aria-hidden={!open}
        className={`absolute z-20 flex gap-0.5 rounded-2xl bg-ink p-1.5 shadow-lg shadow-ink/20 transition-[transform,opacity] ${
          side === "top" ? "bottom-full mb-2.5" : "top-full mt-2.5"
        } ${
          align === "center"
            ? `left-1/2 -translate-x-1/2 ${side === "top" ? "origin-bottom" : "origin-top"}`
            : `right-0 ${side === "top" ? "origin-bottom-right" : "origin-top-right"}`
        } ${
          open
            ? `translate-y-0 scale-100 opacity-100 ${POP.open}`
            : `pointer-events-none scale-[.82] opacity-0 ${POP.close} ${
                side === "top" ? "translate-y-1" : "-translate-y-1"
              }`
        }`}
      >
        {CHANNELS.map(({ label, href, path, viewBox }, i) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noreferrer"
            tabIndex={open ? 0 : -1}
            aria-label={`Join on ${label} (opens in new tab)`}
            onClick={() => setOpen(false)}
            className={`flex h-11 w-11 items-center justify-center rounded-xl text-cream transition-[transform,opacity,color,background-color] hover:bg-cream/10 hover:text-orange focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange focus-visible:ring-offset-2 focus-visible:ring-offset-ink ${
              open
                ? `scale-100 opacity-100 ${POP.open} ${POP.iconDelays[i]}`
                : `scale-50 opacity-0 ${POP.close}`
            }`}
          >
            <svg
              width="22"
              height="22"
              viewBox={viewBox}
              fill="currentColor"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path d={path} />
            </svg>
          </a>
        ))}
      </div>
    </div>
  );
}
