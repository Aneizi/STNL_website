// The Projects page's Import requests section, rendered to static markup:
// the design's copy for a pending request, the linked-project branch, the
// always-rendered heading with nothing under it when there is no request,
// the login label variants, and none of the characters the design forbids.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BuilderImportRequest } from "@/lib/hq/builder-admin-queries";

// The section's server actions, and the ones its helpers' module carries,
// bring the database imports with them; static markup needs their names.
vi.mock("@/lib/hq/actions/builders-admin", () => ({
  attachColosseumProject: vi.fn(), createProjectFromImportRequest: vi.fn(), resolveBuilderImportRequest: vi.fn(),
  updateBuilderOnboardingConfig: vi.fn(), updateBuilderTier: vi.fn(),
}));
vi.mock("@/lib/hq/actions/capabilities", () => ({ grantCaptainCapability: vi.fn(), revokeCaptainCapability: vi.fn() }));
vi.mock("@/lib/hq/actions/captains", () => ({ createCaptainInvitation: vi.fn(), revokeCaptainInvitation: vi.fn() }));

import { ImportRequests } from "@/components/hq/import-requests";

const pending: BuilderImportRequest = {
  id: "00000000-0000-4000-8000-000000000001", name: "Pieter van Dijk", email: "pieter@kaasketen.nl", telegram: null,
  projectUrl: "https://colosseum.com/arena/projects/kaasketen", status: "pending",
  note: "Colosseum shows a 404 for our project since we renamed it. Can you add Kaasketen manually?",
  projectId: null, projectName: null,
};

const render = (requests: BuilderImportRequest[]) => renderToStaticMarkup(createElement(ImportRequests, { requests }));

describe("ImportRequests", () => {
  it("renders a pending request with the design's copy and controls, and no intro paragraph", () => {
    const html = render([pending]);
    expect(html).toMatch(/<h2[^>]*>Import requests<\/h2>/);
    expect(html).toMatch(/<h3[^>]*>Pieter van Dijk<\/h3>/);
    expect(html).toContain(">pending<");
    expect(html).toContain(">pieter@kaasketen.nl<");
    expect(html).toMatch(/<a[^>]*href="https:\/\/colosseum\.com\/arena\/projects\/kaasketen"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>https:\/\/colosseum\.com\/arena\/projects\/kaasketen<\/a>/);
    expect(html).toContain("Can you add Kaasketen manually?");
    expect(html).toContain("Project name in HQ");
    expect(html).toMatch(/<input(?=[^>]*name="name")(?=[^>]*maxLength="200")(?=[^>]*required)/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Create the HQ project<\/button>/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Mark resolved<\/button>/);
    expect(html).not.toContain("Link this Colosseum project");
    expect(html).not.toContain("Projects that Colosseum could not return");
    expect(html).not.toMatch(/[—·]/);
  });

  it("offers to link the Colosseum project once the HQ project exists, and drops Mark resolved once resolved", () => {
    const html = render([{ ...pending, status: "resolved", projectId: "00000000-0000-4000-8000-000000000002", projectName: "Kaasketen" }]);
    expect(html).toContain("HQ project: Kaasketen. It has no Colosseum project linked yet.");
    expect(html).toContain("Colosseum project URL");
    expect(html).toMatch(/<input(?=[^>]*name="url")(?=[^>]*type="url")(?=[^>]*value="https:\/\/colosseum\.com\/arena\/projects\/kaasketen")/);
    expect(html).toContain("Link this Colosseum project");
    expect(html).toContain(">resolved<");
    expect(html).not.toContain("Project name in HQ");
    expect(html).not.toContain("Mark resolved");
  });

  it("renders the heading alone when there is no request", () => {
    const html = render([]);
    expect(html).toMatch(/<h2[^>]*>Import requests<\/h2>/);
    expect(html).not.toContain("<article");
    expect(html).not.toMatch(/No import requests/);
  });

  it("shows a URL that is not a Colosseum project link as text, never as a link", () => {
    const html = render([{ ...pending, projectUrl: "javascript:alert(1)" }]);
    expect(html).not.toContain("href=\"javascript");
    expect(html).toContain("javascript:alert(1)");
  });

  it("labels how each requester signs in", () => {
    const html = render([
      { ...pending, id: "a", email: null, telegram: { username: "tg_handle" } },
      { ...pending, id: "b", email: null, telegram: { username: null } },
      { ...pending, id: "c", email: null, telegram: null },
    ]);
    expect(html).toContain("Telegram: @tg_handle");
    expect(html).toContain(">Telegram account<");
    expect(html).toContain(">No login email<");
  });
});
