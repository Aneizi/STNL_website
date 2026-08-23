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
};

export default nextConfig;
