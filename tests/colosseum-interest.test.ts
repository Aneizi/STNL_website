import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLOSSEUM_INTEREST_COOKIE,
  COLOSSEUM_INTEREST_COOKIE_VALUE,
  parseInterestForm,
} from "@/lib/colosseum-interest";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  revalidate: vi.fn(),
  query: vi.fn(),
  getSql: vi.fn(),
  headers: vi.fn(),
  cookies: vi.fn(),
  getCookie: vi.fn(),
  setCookie: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/headers", () => ({ headers: mocks.headers, cookies: mocks.cookies }));
vi.mock("@/lib/hq/db", () => ({ getSql: mocks.getSql }));
vi.mock("@/lib/hq/colosseum-interest", () => ({ saveColosseumInterest: mocks.save }));

import { submitInterest } from "@/app/colosseum/start/interest/actions";

function form(overrides: Record<string, string | null | undefined> = {}): FormData {
  const fields = {
    name: "  Zoë de Vries  ",
    contactMethod: "telegram",
    contact: "https://t.me/ZoeBuilds",
    path: "beginner",
    website: "",
    ...overrides,
  };
  const result = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) result.set(key, value);
  }
  return result;
}

describe("interest form validation", () => {
  it("normalizes names, Telegram links, and an unchecked Solana answer", () => {
    expect(parseInterestForm(form())).toEqual({
      ok: true,
      data: {
        name: "Zoë de Vries", contactMethod: "telegram", contact: "@zoebuilds",
        builtOnSolana: false, path: "beginner",
      },
    });
  });

  it("normalizes international phone formatting and preserves the checked answer", () => {
    expect(parseInterestForm(form({
      name: "O'Connor", contactMethod: "phone", contact: "0031 (6) 1234-5678",
      builtOnSolana: "on", path: "experienced",
    }))).toMatchObject({
      ok: true,
      data: { name: "O'Connor", contact: "+31612345678", builtOnSolana: true, path: "experienced" },
    });
  });

  it.each([
    { name: " " }, { name: "x".repeat(121) }, { name: null },
    { contact: "https://example.com/zoe" }, { contact: "@" },
    { contactMethod: "email" }, { contactMethod: "phone", contact: "0612345678" },
    { contactMethod: "phone", contact: "+00" },
    { contactMethod: "phone", contact: "+316123456789012345" },
    { path: "https://evil.example" }, { builtOnSolana: "false" }, { website: "bot" },
  ])("rejects malformed or forged input: %j", (overrides) => {
    expect(parseInterestForm(form(overrides)).ok).toBe(false);
  });

  it("rejects file values instead of coercing them to strings", () => {
    const data = form();
    data.set("name", new Blob(["name"]), "name.txt");
    expect(parseInterestForm(data).ok).toBe(false);
  });
});

describe("public interest action", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const cookieValues = new Map<string, string>();
    mocks.cookies.mockResolvedValue({ get: mocks.getCookie, set: mocks.setCookie });
    mocks.getCookie.mockImplementation((key: string) => {
      const value = cookieValues.get(key);
      return value === undefined ? undefined : { name: key, value };
    });
    mocks.setCookie.mockImplementation((key: string, value: string) => cookieValues.set(key, value));
    mocks.getSql.mockReturnValue({ query: mocks.query });
    mocks.headers.mockResolvedValue(new Headers({ "x-real-ip": "127.0.0.1" }));
    mocks.save.mockResolvedValue({ ok: true });
  });

  it.each([
    ["beginner", "/colosseum/start/beginner"],
    ["experienced", "https://colosseum.com/signup"],
  ])("routes %s only after a confirmed save", async (path, redirectTo) => {
    expect(await submitInterest({ ok: false }, form({ path }))).toEqual({ ok: true, redirectTo });
    expect(mocks.save).toHaveBeenCalledWith(
      expect.any(Object), expect.objectContaining({ path, contact: "@zoebuilds" }), "127.0.0.1",
    );
    expect(mocks.revalidate).toHaveBeenCalledWith("/hq", "layout");
    expect(mocks.setCookie).toHaveBeenCalledExactlyOnceWith(
      COLOSSEUM_INTEREST_COOKIE,
      COLOSSEUM_INTEREST_COOKIE_VALUE,
      {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/colosseum",
        maxAge: 60 * 60 * 24 * 180,
      },
    );
  });

  it("does not remember a submission until its asynchronous HQ save succeeds", async () => {
    let completeSave!: (result: { ok: true }) => void;
    mocks.save.mockReturnValue(new Promise<{ ok: true }>((resolve) => { completeSave = resolve; }));

    const pending = submitInterest({ ok: false }, form());
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.setCookie).not.toHaveBeenCalled();

    completeSave({ ok: true });
    expect(await pending).toMatchObject({ ok: true });
    expect(mocks.setCookie).toHaveBeenCalledOnce();
  });

  it("remembers a successful submission across repeat visits and either path without more HQ access", async () => {
    await submitInterest({ ok: false }, form());
    vi.clearAllMocks();

    expect(await submitInterest({ ok: false }, form())).toEqual({
      ok: true, redirectTo: "/colosseum/start/beginner",
    });
    expect(await submitInterest({ ok: false }, form({ path: "experienced" }))).toEqual({
      ok: true, redirectTo: "https://colosseum.com/signup",
    });
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(mocks.headers).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it.each(["", "0", "unknown"])("does not treat the marker %j as a completed submission", async (value) => {
    mocks.getCookie.mockReturnValue({ name: COLOSSEUM_INTEREST_COOKIE, value });
    expect(await submitInterest({ ok: false }, form())).toMatchObject({ ok: true });
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.setCookie).toHaveBeenCalledOnce();
  });

  it("does not touch storage for invalid or honeypot submissions", async () => {
    const result = await submitInterest({ ok: false }, form({ website: "filled" }));
    expect(result.ok).toBe(false);
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it("keeps people on the form when storage is unavailable without exposing details", async () => {
    mocks.save.mockRejectedValue(new Error("private database detail"));
    expect(await submitInterest({ ok: false }, form())).toEqual({
      ok: false, error: "We couldn't save your interest. Please try again shortly.",
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it("returns a limiter failure without a redirect", async () => {
    mocks.save.mockResolvedValue({ ok: false, error: "Too many attempts." });
    expect(await submitInterest({ ok: false }, form())).toEqual({ ok: false, error: "Too many attempts." });
    expect(mocks.setCookie).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
