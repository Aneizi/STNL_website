"use client";

import { useState } from "react";
import Image from "next/image";
import { PROJECT_FALLBACK_IMAGE } from "@/lib/hq/colosseum-snapshot";

/**
 * A project's avatar: the imported Colosseum image, or the approved globe
 * medallion when there is none or the source image fails to load.
 *
 * Remote images deliberately use a plain `<img>`. Colosseum hosts project
 * images on a third-party CDN, and routing them through `next/image` would
 * mean allow-listing that host in `remotePatterns` and having this
 * application fetch and re-serve arbitrary remote bytes — the "unrestricted
 * image proxy" the plan rules out. A plain tag lets the viewer's browser
 * fetch the image directly, adds no server-side fetch, and keeps the
 * fallback a local, size-optimized asset. `referrerPolicy="no-referrer"` keeps the HQ page
 * the image sits on out of that CDN's logs.
 *
 * This is decorative project imagery. It is never a fallback for a human
 * avatar: a roster member with no picture gets no picture.
 */
export function BuilderProjectImage({ src, name, size = 64, className }: {
  src: string | null;
  /** The project's name. Used for the accessible description, never rendered as markup. */
  name: string;
  size?: number;
  className?: string;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const failed = src === failedSource;
  const imageStyle = { width: size, height: size, maxWidth: "100%", objectFit: "contain" as const, borderRadius: 8, flexShrink: 0 };
  // Only the trusted local asset goes through the image optimizer. Sending
  // its full 1 MB original for a 64 px avatar wastes bandwidth on mobile.
  if (!src || failed) return <Image src={PROJECT_FALLBACK_IMAGE} alt="" aria-hidden width={size} height={size} sizes={`${size}px`} className={className} style={imageStyle} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- deliberate: see the comment above. next/image would mean allow-listing a third-party CDN in remotePatterns and proxying arbitrary remote bytes through this app, which the plan rules out.
    <img
      src={src}
      alt={`${name} project image`}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedSource(src)}
      className={className}
      style={imageStyle}
    />
  );
}
