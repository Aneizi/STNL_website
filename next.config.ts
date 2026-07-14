import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Luma event cover images
    remotePatterns: [{ protocol: "https", hostname: "**.lumacdn.com" }],
  },
};

export default nextConfig;
