import Image from "next/image";
import Link from "next/link";
import { IconArrowRight } from "symbols-react";
import styles from "./colosseum-invitation.module.css";

export function ColosseumInvitation() {
  return (
    <Link
      href="/colosseum"
      aria-label="Embark on an adventure: Colosseum hackathon"
      className={`${styles.invitation} mt-3 block max-w-full overflow-hidden rounded-lg border border-ink/15 text-ink motion-safe:transition-colors motion-safe:duration-150 hover:border-ink/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange focus-visible:ring-offset-4 focus-visible:ring-offset-cream active:border-orange`}
    >
      <span className="relative block h-24 overflow-hidden">
        <Image
          src="/colosseum/worlds-fair-garden.png"
          alt=""
          fill
          loading="eager"
          sizes="(max-width: 368px) calc(100vw - 48px), 320px"
          className="object-cover object-bottom"
        />
        <span className={`${styles.wordmark} absolute inset-0 flex items-center justify-center px-4`}>
          <Image
            src="/colosseum/worlds-fair-wordmark.png"
            alt=""
            width={932}
            height={73}
            sizes="288px"
            className="h-auto w-full drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
          />
        </span>
        <span
          aria-hidden="true"
          className={`${styles.caption} absolute inset-0 flex items-center justify-center gap-3 bg-white/85 px-4 text-sm font-medium text-black`}
        >
          Embark on an adventure
          <IconArrowRight
            fill="currentColor"
            className="h-3 w-4 shrink-0"
          />
        </span>
      </span>
    </Link>
  );
}
