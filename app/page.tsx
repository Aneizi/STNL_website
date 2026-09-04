import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ExternalMark } from "@/components/external-mark";
import { JoinMenu } from "@/components/join-menu";
import { LINKS } from "@/lib/links";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange focus-visible:ring-offset-2 focus-visible:ring-offset-cream";

const NAV_ITEM = `py-2 -my-2 text-ink transition-colors duration-200 hover:text-orange ${FOCUS_RING}`;

export default function HomePage() {
  return (
    <main className="relative flex min-h-dvh w-full flex-1 flex-col min-[900px]:flex-row">
      {/* Canal illustration — decorative full-bleed left panel */}
      <div
        aria-hidden="true"
        className="relative h-[36vh] w-full min-[900px]:h-auto min-[900px]:w-[46%]"
      >
        <Image
          src="/landing/stnl_cafe.png"
          alt=""
          fill
          priority
          sizes="(min-width: 900px) 46vw, 100vw"
          className="object-cover object-center"
        />
      </div>

      <div className="flex w-full flex-1 flex-col items-center px-6 pb-8 pt-7 min-[900px]:w-[54%] min-[900px]:flex-none min-[900px]:px-14 min-[900px]:pb-11 min-[900px]:pt-9">
        <Link href="/" className={`flex items-center gap-2.5 ${FOCUS_RING}`}>
          <Image
            src="/landing/st-orange.png"
            alt=""
            width={2154}
            height={2116}
            sizes="34px"
            className="h-auto w-[34px]"
          />
          <span className="text-[19px] font-bold tracking-[-0.01em] text-ink">
            superteam
          </span>
        </Link>

        <div className="my-auto flex flex-col items-center gap-[18px] py-10">
          <h1 className="text-center font-serif text-[44px]/[1.04] font-normal tracking-[-0.01em] text-ink [text-wrap:pretty] min-[900px]:text-[76px]/[1.04]">
            A home for{" "}
            <em className="italic text-orange">
              everyone
              {/* `static` cancels preflight's relative top:-0.5em so only
                  vertical-align:super raises it, as in the design */}
              <sup className="static align-super text-[17px] min-[900px]:text-[28px]">
                *
              </sup>
            </em>{" "}
            building on Solana
          </h1>
          <p className="text-center text-lg/[1.4] text-subtle">
            *In The Netherlands
          </p>
        </div>

        <nav
          aria-label="Primary"
          className="flex flex-wrap items-center justify-center gap-2 text-[13px] font-semibold uppercase tracking-[0.14em]"
        >
          <Link href="/about" className={NAV_ITEM}>
            About
          </Link>
          <span aria-hidden="true" className="text-faded">
            /
          </span>
          <Link href="/events" className={NAV_ITEM}>
            Events
          </Link>
          <span aria-hidden="true" className="text-faded">
            /
          </span>
          <a
            href={LINKS.earn}
            target="_blank"
            rel="noreferrer"
            className={NAV_ITEM}
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
          <JoinMenu className={NAV_ITEM} align="center" side="top" />
        </nav>
      </div>
    </main>
  );
}
