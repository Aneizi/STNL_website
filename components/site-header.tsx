import Image from "next/image";
import Link from "next/link";
import { ExternalMark } from "@/components/external-mark";
import { LINKS } from "@/lib/links";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange focus-visible:ring-offset-2 focus-visible:ring-offset-cream";

const NAV_ITEM = `py-2 -my-2 transition-colors duration-200 hover:text-orange ${FOCUS_RING}`;

// -mb-1 cancels the 4px of padding+border below the text so the label
// stays baseline-aligned with its siblings in the items-center flex row
const ACTIVE_ITEM = `-mb-1 border-b-2 border-orange pb-0.5 text-orange ${FOCUS_RING}`;

type NavPage = "about" | "events";

export function SiteHeader({
  active,
  navOverlay = false,
}: {
  active?: NavPage;
  /**
   * ≥900px: pin the nav to the page's right edge (over the illustration)
   * with a cream backdrop that dissolves outward, mirroring the
   * illustration's own edge fade. Requires the page root to be the nearest
   * positioned ancestor.
   */
  navOverlay?: boolean;
}) {
  const overlayClasses = navOverlay
    ? " min-[900px]:absolute min-[900px]:right-14 min-[900px]:top-9 min-[900px]:z-10 min-[900px]:before:absolute min-[900px]:before:-inset-x-16 min-[900px]:before:-inset-y-10 min-[900px]:before:-z-10 min-[900px]:before:bg-[radial-gradient(ellipse_at_center,var(--cream)_45%,rgba(251,247,240,0.55)_68%,rgba(251,247,240,0)_100%)] min-[900px]:before:content-['']"
    : "";
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <Link href="/" className={`flex items-center gap-2.5 ${FOCUS_RING}`}>
        <Image
          src="/landing/st-orange.png"
          alt=""
          width={2154}
          height={2116}
          sizes="30px"
          className="h-auto w-[30px]"
        />
        <span className="text-[17px] font-bold tracking-[-0.01em] text-ink">
          superteam
        </span>
      </Link>

      <nav
        aria-label="Primary"
        className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em]${overlayClasses}`}
      >
        <Link
          href="/about"
          aria-current={active === "about" ? "page" : undefined}
          className={
            active === "about" ? ACTIVE_ITEM : `text-ink ${NAV_ITEM}`
          }
        >
          About
        </Link>
        <span aria-hidden="true" className="text-faded">
          /
        </span>
        <Link
          href="/events"
          aria-current={active === "events" ? "page" : undefined}
          className={
            active === "events" ? ACTIVE_ITEM : `text-ink ${NAV_ITEM}`
          }
        >
          Events
        </Link>
        <span aria-hidden="true" className="text-faded">
          /
        </span>
        <a
          href={LINKS.earn}
          target="_blank"
          rel="noreferrer"
          className={`text-ink ${NAV_ITEM}`}
        >
          <span className="relative pr-[11px]">
            Earn
            <ExternalMark />
          </span>
          <span className="sr-only"> (opens in new tab)</span>
        </a>
        <span aria-hidden="true" className="text-faded">
          /
        </span>
        <a
          href={LINKS.join}
          target="_blank"
          rel="noreferrer"
          className={`text-ink ${NAV_ITEM}`}
        >
          <span className="relative pr-[11px]">
            Join
            <ExternalMark />
          </span>
          <span className="sr-only"> (opens in new tab)</span>
        </a>
      </nav>
    </header>
  );
}
