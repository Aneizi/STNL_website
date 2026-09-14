"use client";

import { useState } from "react";
import { PROJECT_FALLBACK_IMAGE } from "@/lib/hq/colosseum-snapshot";

/**
 * A project's avatar: the imported Colosseum image, or the approved globe
 * medallion when there is none or the source image fails to load.
 *
 * Deliberately a plain `<img>` and not `next/image`. Colosseum hosts project
 * images on a third-party CDN, and routing them through `next/image` would
 * mean allow-listing that host in `remotePatterns` and having this
 * application fetch and re-serve arbitrary remote bytes — the "unrestricted
 * image proxy" the plan rules out. A plain tag lets the viewer's browser
 * fetch the image directly, adds no server-side fetch, and keeps the
 * fallback a local asset. `referrerPolicy="no-referrer"` keeps the HQ page
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
  const [failed, setFailed] = useState(false);
  const url = !src || failed ? PROJECT_FALLBACK_IMAGE : src;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- deliberate: see the comment above. next/image would mean allow-listing a third-party CDN in remotePatterns and proxying arbitrary remote bytes through this app, which the plan rules out.
    <img
      src={url}
      alt={src && !failed ? `${name} project image` : ""}
      aria-hidden={!src || failed ? true : undefined}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
      style={{ width: size, height: size, maxWidth: "100%", objectFit: "contain", borderRadius: 8, flexShrink: 0 }}
    />
  );
}
