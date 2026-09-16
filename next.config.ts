import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/auth/*": ["./lib/hq/email-assets/superteam-nl.png"],
  },
  async redirects() {
    return [{ source: "/hq/signin", destination: "/hq/login", permanent: true }];
  },
  images: {
    // Luma event cover images
    remotePatterns: [{ protocol: "https", hostname: "**.lumacdn.com" }],
    // 90 for the full-bleed illustration panels; 75 stays the default
    qualities: [75, 90],
  },
  async rewrites() {
    return [
      // Static deck (public/deck/) presented at a clean path
      { source: "/pitch-deck", destination: "/deck/index.html" },
    ];
  },
  async headers() {
    return [
      {
        // A team join link (phase 3) carries a bearer code in its address,
        // the same shape as the Captain invitation route below: the code is
        // one segment of the path, so it must not travel in a Referer header
        // on a navigation away from the page, and the page must not be
        // indexed. Unlike /hq/invite/<token>, this one is a real page rather
        // than a redirect-only Route Handler, so it also inherits the /hq
        // metadata robots signal; the header is belt and braces.
        source: "/hq/join/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, noarchive" },
        ],
      },
      {
        // The Captain invitation flow (task T4.3): the exchange step's
        // address carries a bearer token and the continuation page's cookie
        // is a bearer-adjacent id, so neither may leak into a Referer header
        // on a navigation away from either route. X-Robots-Tag covers the
        // token route itself: it is a Route Handler that only ever emits a
        // redirect, so it carries no <meta>/metadata robots signal of its
        // own the way the continuation page inherits from app/hq/layout.tsx.
        source: "/hq/invite/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, noarchive" },
        ],
      },
    ];
  },
};

export default nextConfig;
