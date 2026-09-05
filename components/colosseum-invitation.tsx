import Image from "next/image";
import Link from "next/link";
import { IconArrowRight } from "symbols-react";

export function ColosseumInvitation() {
  return (
    <Link
      href="/colosseum"
      className="group mt-3 block w-80 max-w-full overflow-hidden rounded-lg border border-ink/15 text-ink transition-colors duration-150 hover:border-ink/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange focus-visible:ring-offset-4 focus-visible:ring-offset-cream active:border-orange"
    >
      <span className="relative block h-24 overflow-hidden">
        <Image
          src="/colosseum/worlds-fair-banner.png"
          alt=""
          fill
          sizes="(max-width: 368px) calc(100vw - 48px), 320px"
          className="object-cover object-bottom"
        />
        <span className="absolute inset-0 flex items-center justify-center px-4">
          <Image
            src="/colosseum/worlds-fair-wordmark.png"
            alt="Colosseum hackathon"
            width={932}
            height={73}
            sizes="288px"
            className="h-auto w-full drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
          />
        </span>
      </span>
      <span className="flex min-h-9 items-center justify-between gap-3 px-3 py-2 text-sm font-medium">
        Embark on an adventure
        <IconArrowRight
          aria-hidden="true"
          fill="currentColor"
          className="h-3 w-4 shrink-0 text-black"
        />
      </span>
    </Link>
  );
}
