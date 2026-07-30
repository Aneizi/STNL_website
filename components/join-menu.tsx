"use client";

import { useId, useRef, useState } from "react";
import type { ToggleEvent } from "react";
import { IconChevronDown } from "symbols-react";
import { LINKS } from "@/lib/links";
import { SOCIAL_GLYPHS } from "@/lib/social-glyphs";

/**
 * "Join" nav item that pops a small card with the community channels.
 *
 * Built on the native Popover API: the browser handles open/close,
 * outside-click and Escape dismissal, and focus return. Placement is
 * CSS anchor positioning; the animation lives entirely in globals.css
 * (`.join-popover`). React state only drives the chevron.
 */
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  // Browsers without CSS anchor positioning still get the top-layer
  // popover; place it against the trigger by hand.
  const positionFallback = (popover: HTMLElement) => {
    if (CSS.supports("position-anchor: --a")) return;
    const anchor = buttonRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const card = popover.getBoundingClientRect();
    popover.style.top =
      side === "top"
        ? `${anchor.top - 10 - card.height}px`
        : `${anchor.bottom + 10}px`;
    popover.style.left =
      align === "center"
        ? `${anchor.left + anchor.width / 2 - card.width / 2}px`
        : `${anchor.right - card.width}px`;
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        popoverTarget={popoverId}
        className={`join-trigger uppercase ${className}`}
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
        popover="auto"
        onToggle={(e: ToggleEvent<HTMLDivElement>) => {
          setOpen(e.newState === "open");
          if (e.newState === "open") positionFallback(e.currentTarget);
        }}
        className={`join-popover${side === "top" ? " join-popover--top" : ""}${
          align === "center" ? " join-popover--center" : ""
        } gap-0.5 rounded-2xl bg-ink p-1.5 shadow-lg shadow-ink/20`}
      >
        {CHANNELS.map(({ label, href, path, viewBox }) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={`Join on ${label} (opens in new tab)`}
            onClick={(e) =>
              e.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover()
            }
            className="flex h-11 w-11 items-center justify-center rounded-xl text-cream transition-colors duration-200 hover:bg-cream/10 hover:text-orange focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
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
    </>
  );
}
