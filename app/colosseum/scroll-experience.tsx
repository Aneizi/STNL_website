"use client";

import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";

/** Native document scrolling, with an optional, gentle fade on the artwork. */
export function ColosseumExperience({ children, className }: { children: ReactNode; className: string }) {
  const artwork = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = artwork.current;
    if (!element) return;

    const scrollCue = element.querySelector<HTMLAnchorElement>("[data-scroll-cue]");
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;

    const update = () => {
      frame = 0;
      const bounds = element.getBoundingClientRect();
      // Dismiss once per visit, including when the user scrolls without clicking.
      if (bounds.top < -4 && scrollCue && scrollCue.dataset.dismissed !== "true") {
        scrollCue.dataset.dismissed = "true";
        scrollCue.inert = true;
        scrollCue.setAttribute("aria-hidden", "true");
      }
      if (preference.matches) {
        element.style.removeProperty("--artwork-opacity");
        return;
      }
      const progress = Math.min(1, Math.max(0, -bounds.top / bounds.height));
      element.style.setProperty("--artwork-opacity", String(1 - progress * 0.45));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    preference.addEventListener("change", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      preference.removeEventListener("change", schedule);
    };
  }, []);

  return <div ref={artwork} className={className}>{children}</div>;
}

/** Keeps real anchor URLs and focuses the destination for keyboard navigation. */
export function FairAnchor({ href, children, ...props }: ComponentProps<"a"> & { href: `#${string}` }) {
  return (
    <a {...props} href={href} onClick={(event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = document.getElementById(href.slice(1));
      if (!target) return;
      event.preventDefault();
      window.history.pushState(null, "", href);
      target.focus({ preventScroll: true });
      target.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
        block: "start",
      });
    }}>{children}</a>
  );
}
