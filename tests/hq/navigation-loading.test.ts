import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HqPageLoading from "@/app/hq/(app)/loading";

const HQ = join(process.cwd(), "app/hq");

/** Every route file under app/hq, as paths relative to app/hq. */
function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? routeFiles(full) : [relative(HQ, full)];
  });
}

describe("HQ navigation loading boundary", () => {
  it("renders an accessible, layout-stable destination shell", () => {
    const html = renderToStaticMarkup(HqPageLoading());

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading page…");
    expect(html.match(/hq-loading-row/g)).toHaveLength(5);
  });

  // Next.js does not prefetch a dynamic route with no loading boundary above
  // it, so a page that inherits none makes its navbar click hold the previous
  // page until the server responds. That is invisible in review: the route
  // works, it is just slow. Anything added outside the (app) group needs its
  // own boundary.
  it("covers every navigable page with a loading boundary", () => {
    const files = routeFiles(HQ);
    const pages = files.filter((f) => f.endsWith("page.tsx"));
    const boundaries = files.filter((f) => f.endsWith("loading.tsx"));

    expect(pages.length).toBeGreaterThan(4);

    // The two pages reachable without a session render from the request alone.
    const navigable = pages.filter(
      (page) => !page.startsWith("login/") && !page.startsWith("change-password/"),
    );
    const uncovered = navigable.filter(
      (page) =>
        !boundaries.some((boundary) =>
          page.startsWith(boundary.slice(0, -"loading.tsx".length)),
        ),
    );

    expect(uncovered).toEqual([]);
  });
});
