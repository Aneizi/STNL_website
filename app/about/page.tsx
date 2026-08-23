import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { GezelligTerm } from "@/components/gezellig-term";
import { SiteHeader } from "@/components/site-header";
import { SocialLinks } from "@/components/social-links";
import { IconArrowRight } from "symbols-react";
import { LINKS } from "@/lib/links";

export const metadata: Metadata = {
  title: "About",
  description:
    "Superteam NL is the Dutch chapter of Solana's global builder network - a community of builders, creatives and operators.",
};

const PILLARS = [
  {
    num: "01",
    title: "Build",
    body: (
      <>
        Hackathon cohorts: weeks of heads-down shipping with mentors, ending in
        a demo day. Many variations, all very fun.
      </>
    ),
  },
  {
    num: "02",
    title: "Gather",
    body: (
      <>
        Meet other community members across curated venues. All on the{" "}
        <Link
          href="/events"
          className="text-orange underline underline-offset-2 transition-colors hover:text-orange-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          events calendar
        </Link>
        .
      </>
    ),
  },
  {
    num: "03",
    title: "Earn",
    body: (
      <>
        Equity-free grants and bounties across a plethora of categories -
        design, code, content, and more - paid in stablecoins.
      </>
    ),
  },
];

export default function AboutPage() {
  return (
    <main className="relative flex min-h-dvh w-full flex-1 flex-col min-[900px]:flex-row">
      {/* Canal illustration — decorative, fades into the cream panel */}
      <div
        aria-hidden="true"
        className="relative h-[36vh] w-full [mask-image:linear-gradient(to_bottom,black_55%,transparent_100%)] min-[900px]:absolute min-[900px]:inset-y-0 min-[900px]:right-0 min-[900px]:h-auto min-[900px]:w-[46%] min-[900px]:[mask-image:linear-gradient(to_right,transparent_0%,rgba(0,0,0,0.55)_40%,black_70%)]"
      >
        {/* `sizes` is height-derived: object-cover in a panel taller than the
            image's 2.33 aspect scales it to the panel's height, so its
            effective width is 2.33× that height (235vh desktop, 84vh mobile) —
            declaring the panel's 46vw here made the optimizer serve a variant
            ~3× too small, which is what blurred it. */}
        <Image
          src="/landing/canal-wide.png"
          alt=""
          fill
          preload
          quality={90}
          sizes="(min-width: 900px) 235vh, 84vh"
          className="object-cover object-right"
        />
      </div>

      {/* not `relative`: the overlay nav positions against <main> */}
      <div className="flex w-full flex-1 flex-col px-6 pb-12 pt-6 min-[900px]:w-[54%] min-[900px]:flex-none min-[900px]:px-14 min-[900px]:pb-16 min-[900px]:pt-[30px]">
        <SiteHeader active="about" navOverlay />

        {/* On desktop the column's spare height is split evenly around the
            content (justify-center) instead of pooling below the button, so
            the text block sits at the panel's vertical centre; py-6 keeps a
            floor gap to the header and footer on short viewports. Mobile keeps
            the top-anchored flow. */}
        <div className="flex flex-1 flex-col min-[900px]:justify-center min-[900px]:py-6">
          {/* Both blocks are capped to a readable measure: uncapped, the intro
            ran the full 666px column at ~83 characters a line. */}
          <div className="mt-14 flex flex-col gap-4 min-[900px]:mt-0">
            <h1 className="font-serif text-[38px]/[1.08] font-normal tracking-[-0.01em] text-ink [text-wrap:pretty] min-[900px]:max-w-[620px] min-[900px]:text-[52px]/[1.08]">
              The most <GezelligTerm /> web3 community in The Netherlands.
            </h1>
            <p className="text-base/[1.6] text-muted [text-wrap:pretty] min-[900px]:max-w-[540px]">
              Superteam NL is the Dutch chapter of Solana&apos;s global builder
              network - a community of builders, creatives and operators that
              create winning products and services within the ecosystem.
            </p>
          </div>

          {/* A ledger, matching EventsLedger's rows: the numeral sits in its own
            gutter but the rules span the full measure, so the offset reads as a
            table rather than a stray indent. `sm:contents` dissolves the
            numeral/title wrapper into the grid so both share row 1's baseline;
            below sm the gutter would cost too much measure, so they run inline. */}
          <ul className="mt-8 flex flex-col">
            {PILLARS.map(({ num, title, body }, i) => (
              <li
                key={num}
                className={`py-4 sm:grid sm:grid-cols-[56px_minmax(0,1fr)] sm:items-baseline sm:gap-x-6 ${
                  i === 0 ? "border-t-2 border-t-ink" : "border-t border-t-line"
                } ${i === PILLARS.length - 1 ? "border-b-2 border-b-ink" : ""}`}
              >
                <div className="flex items-baseline gap-[13px] sm:contents">
                  <span
                    aria-hidden="true"
                    className="font-serif text-2xl text-faded sm:col-start-1 sm:row-start-1"
                  >
                    {num}
                  </span>
                  <h2 className="font-serif text-2xl font-normal text-ink sm:col-start-2 sm:row-start-1">
                    {title}
                  </h2>
                </div>
                <p className="mt-[5px] max-w-[520px] text-[14.5px]/[1.55] text-muted [text-wrap:pretty] sm:col-start-2 sm:row-start-2">
                  {body}
                </p>
              </li>
            ))}
          </ul>

          {/* On mobile the band claims the space between the list's closing rule
            and the footer hairline and centres the button in it; on desktop it
            stays at its 76px minimum (flex-none) so the wrapper's
            justify-center owns the spare height instead. No `self-start` on
            the anchor: align-self would override the band's align-items. */}
          <div className="flex min-h-[76px] flex-1 items-center min-[900px]:flex-none">
            <a
              href={LINKS.pitchDeck}
              className="group inline-flex min-h-11 items-center gap-2.5 border-2 border-ink px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-ink transition-colors duration-200 hover:bg-ink hover:text-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
            >
              View the pitch deck
              <span
                aria-hidden="true"
                className="inline-flex text-orange transition-colors duration-200 group-hover:text-cream"
              >
                <IconArrowRight
                  fill="currentColor"
                  className="h-[11px] w-[13.75px]"
                />
              </span>
            </a>
          </div>
        </div>

        {/* A hairline closes the column so the social row sits on something
            instead of floating on whatever mt-auto left over. */}
        <div className="border-t border-line pt-5">
          <SocialLinks />
        </div>
      </div>
    </main>
  );
}
