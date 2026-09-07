import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/about", "/events", "/colosseum", "/colosseum/start", "/colosseum/start/beginner", "/colosseum/start/experienced", "/colosseum/solana-new", "/pitch-deck"].map((path) => ({
    url: new URL(path, SITE_URL).href,
  }));
}
