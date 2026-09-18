// The onboarding pages (welcome, initialize, join and a clicked join link):
// each gates itself first, with its own path as the way back after sign-in,
// then renders the design's copy and links. The store is mocked to the one
// read these pages make, the open editions, live first.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ requireMember: vi.fn(), hackathons: vi.fn() }));
vi.mock("@/lib/hq/member-auth", () => ({ requireMember: mocks.requireMember, currentMember: vi.fn() }));
vi.mock("@/lib/hq/builder-store", () => ({ builderStore: () => ({ hackathons: mocks.hackathons }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
  useRouter: () => ({ replace() {}, refresh() {}, push() {} }),
  usePathname: () => "/hq/welcome",
}));
vi.mock("@/lib/hq/actions/builders", () => ({
  acceptBuilderInvite: vi.fn(), importBuilderTeam: vi.fn(), previewBuilderImport: vi.fn(), previewBuilderInvite: vi.fn(), requestBuilderReview: vi.fn(),
}));
vi.mock("symbols-react", () => ({ IconArrowRight: (props: Record<string, unknown>) => createElement("svg", props) }));

import WelcomePage from "@/app/hq/(member)/welcome/page";
import InitializePage from "@/app/hq/(member)/initialize/page";
import JoinPage from "@/app/hq/(member)/join/page";
import JoinWithCodePage from "@/app/hq/(member)/join/[code]/page";

const EDITIONS = [{ id: 41, name: "Crypto World's Fair" }, { id: 42, name: "Next edition" }];
const CODE = "917F94-8CE496-4D2C7A-4C70F1";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireMember.mockResolvedValue({ id: "acct-1", email: null, name: "Nienke Visser" });
  mocks.hackathons.mockResolvedValue(EDITIONS);
});

describe("the welcome page", () => {
  it("gates itself, then offers import, join and Home as links, with Back to the public start page", async () => {
    const html = renderToStaticMarkup(await WelcomePage());
    expect(mocks.requireMember).toHaveBeenCalledWith("/hq/welcome");
    expect(html).toMatch(/<a[^>]*href="\/colosseum\/start"[^>]*>Back<\/a>/);
    expect(html).toContain("Find your <em>team.</em>");
    expect(html).toContain("Choose how you’d like to take part.");
    expect(html).toContain('href="/hq/initialize?hackathon=41"');
    expect(html).toContain('href="/hq/join"');
    expect(html).toMatch(/<a[^>]*href="\/hq\/dashboard"[^>]*>I’m not building this time<\/a>/);
    expect(html).not.toMatch(/<select|<form|Your hackathon|no open hackathons|Next edition/);
    expect(html).not.toMatch(/[—·]/);
  });

  it("links Initialize without an edition when none is open, instead of an empty state", async () => {
    mocks.hackathons.mockResolvedValue([]);
    const html = renderToStaticMarkup(await WelcomePage());
    expect(html).toContain('href="/hq/initialize"');
    expect(html).not.toMatch(/\?hackathon=|no open hackathons/);
  });
});

describe("the initialize page", () => {
  const render = async (hackathon?: string) => renderToStaticMarkup(await InitializePage({ searchParams: Promise.resolve({ hackathon }) }));

  it("gates itself with the edition it was asked for and renders the design's intro over the link form", async () => {
    const html = await render("42");
    expect(mocks.requireMember).toHaveBeenCalledWith("/hq/initialize?hackathon=42");
    expect(html).toMatch(/<a[^>]*href="\/hq\/welcome"[^>]*>Back<\/a>/);
    expect(html).toContain("Initialize your <em>team.</em>");
    expect(html).toContain("Use the Colosseum project registered in the Netherlands for Colosseum Crypto World&#x27;s Fair.");
    expect(html).toContain("Colosseum project link");
    expect(html).toContain("Can’t find your project?");
    expect(html).not.toMatch(/Next edition|Project imports open|Go to my HQ|Which teammate/);
    expect(html).not.toMatch(/[—·]/);
  });

  it("falls back to the first open edition without a parameter", async () => {
    const html = await render();
    expect(mocks.requireMember).toHaveBeenCalledWith("/hq/initialize");
    expect(html).toContain("Colosseum project link");
  });

  it("is not found for an edition that is not open", async () => {
    await expect(render("99")).rejects.toThrow("NOT_FOUND");
  });

  it("is not found when no edition is open at all", async () => {
    mocks.hackathons.mockResolvedValue([]);
    await expect(render()).rejects.toThrow("NOT_FOUND");
  });
});

describe("the join pages", () => {
  it("gates itself and starts with the design's intro over the link form", async () => {
    const html = renderToStaticMarkup(await JoinPage());
    expect(mocks.requireMember).toHaveBeenCalledWith("/hq/join");
    expect(html).toMatch(/<a[^>]*href="\/hq\/welcome"[^>]*>Back<\/a>/);
    expect(html).toContain("Join your <em>team.</em>");
    expect(html).toContain("Paste your team’s join link.");
    expect(html).toContain("Team join link");
    expect(html).not.toMatch(/[—·]/);
  });

  it("returns to the clicked link after sign-in and fills the code in", async () => {
    const html = renderToStaticMarkup(await JoinWithCodePage({ params: Promise.resolve({ code: CODE }) }));
    expect(mocks.requireMember).toHaveBeenCalledWith(`/hq/join/${CODE}`);
    expect(html).toContain(`value="${CODE}"`);
    expect(html).toContain("Paste your team’s join link.");
  });
});
