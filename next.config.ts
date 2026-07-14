import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Luma event cover images
    remotePatterns: [{ protocol: "https", hostname: "**.lumacdn.com" }],
  },
  async rewrites() {
    return [
      // Static deck (public/deck/) presented at a clean path
      { source: "/pitch-deck", destination: "/deck/index.html" },
    ];
  },
};

export default nextConfig;
