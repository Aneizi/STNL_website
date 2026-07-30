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
        Bounties and gigs from Solana teams worldwide - design, code, content -
        paid in stablecoins.
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
        <Image
          src="/landing/canal-wide.png"
          alt=""
          fill
          priority
          sizes="(min-width: 900px) 46vw, 100vw"
          className="object-cover object-right"
        />
      </div>

      {/* not `relative`: the overlay nav positions against <main> */}
      <div className="flex w-full flex-1 flex-col px-6 pb-10 pt-6 min-[900px]:w-[54%] min-[900px]:flex-none min-[900px]:px-14 min-[900px]:pb-12 min-[900px]:pt-[30px]">
        <SiteHeader active="about" navOverlay />

        <div className="mt-9 flex flex-col gap-5 min-[900px]:mt-[46px]">
          <h1 className="font-serif text-[38px]/[1.08] font-normal tracking-[-0.01em] text-ink [text-wrap:pretty] min-[900px]:text-[52px]/[1.08]">
            The most <GezelligTerm /> web3 community in The Netherlands.
          </h1>
          <p className="text-base/[1.6] text-muted [text-wrap:pretty]">
            Superteam NL is the Dutch chapter of Solana&apos;s global builder
            network - a community of builders, creatives and operators that
            create winning products and services within the ecosystem.
          </p>
        </div>

        <ul className="mt-[34px] flex flex-col">
          {PILLARS.map(({ num, title, body }, i) => (
            <li
              key={num}
              className={`flex gap-[18px] py-5 ${
                i === 0 ? "border-t-2 border-t-ink" : "border-t border-t-line"
              } ${i === PILLARS.length - 1 ? "border-b border-b-line" : ""}`}
            >
              <span
                aria-hidden="true"
                className="w-11 flex-none font-serif text-[22px]/[normal] text-faded"
              >
                {num}
              </span>
              <div className="flex flex-col gap-[5px]">
                <h2 className="font-serif text-2xl font-normal text-ink">
                  {title}
                </h2>
                <p className="text-[14.5px]/[1.55] text-muted [text-wrap:pretty]">
                  {body}
                </p>
              </div>
            </li>
          ))}
        </ul>

        <a
          href={LINKS.pitchDeck}
          className="group mt-[30px] inline-flex min-h-11 items-center gap-2.5 self-start border-2 border-ink px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-ink transition-colors duration-200 hover:bg-ink hover:text-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
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

        <div className="mt-auto pt-[30px]">
          <SocialLinks />
        </div>
      </div>
    </main>
  );
}
