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
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          ...(process.env.VERCEL === "1"
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
            : []),
        ],
      },
      {
        source: "/hq/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          // These directives protect the console without blocking its inline
          // styles, Next scripts, remote project images, or embedded decks.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
        ],
      },
      {
        // Bearer URLs override the default policy and must never be indexed.
        source: "/hq/join/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, noarchive" },
        ],
      },
      {
        // Also covers the redirect-only token route and its continuation.
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
