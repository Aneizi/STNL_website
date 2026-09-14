import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
