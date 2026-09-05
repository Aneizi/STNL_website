import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/about", "/events", "/colosseum", "/colosseum/start", "/colosseum/start/beginner", "/pitch-deck"].map((path) => ({
    url: new URL(path, SITE_URL).href,
  }));
}
