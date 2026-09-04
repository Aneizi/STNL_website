import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/hq/api/"],
      // Allow HQ pages to be crawled so their existing noindex tags are read.
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
