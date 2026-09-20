import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getAuth: vi.fn(),
  handler: vi.fn<(request: Request) => Promise<Response>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/hq/member-auth", () => ({
  getAuth: auth.getAuth,
  MemberAuthUnavailableError: class extends Error {
    constructor() { super("Account sign-in is not available yet. Please try again later."); }
  },
}));

import { GET, POST } from "@/app/api/auth/[...all]/route";
import { MemberAuthUnavailableError } from "@/lib/hq/member-auth";
import { memberEmailDeliveryFailed } from "@/lib/hq/member-auth-delivery";

const ORIGIN = "https://hq-test.example";
const noStore = (response: Response) => expect(response.headers.get("cache-control")).toBe("private, no-store");

describe("public auth HTTP response privacy", () => {
  beforeEach(() => {
    auth.getAuth.mockReset().mockReturnValue({ handler: auth.handler });
    auth.handler.mockReset();
  });

  it("prevents caching the anonymous session response even when the provider sets no cache header", async () => {
    auth.handler.mockResolvedValue(Response.json(null));
    const response = await GET(new Request(`${ORIGIN}/api/auth/get-session`));
    noStore(response);
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it("keeps the session body and each Set-Cookie line while replacing public caching", async () => {
    const session = { user: { id: "test-member" }, session: { id: "test-session" } };
    const cookies = [
      "session=test-only; Path=/; HttpOnly; Secure; SameSite=Lax",
      "state=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure",
    ];
    const providerResponse = Response.json(session, { headers: { "Cache-Control": "public, max-age=60" } });
    for (const cookie of cookies) providerResponse.headers.append("Set-Cookie", cookie);
    auth.handler.mockResolvedValue(providerResponse);
    const response = await POST(new Request(`${ORIGIN}/api/auth/sign-in/email-otp`, { method: "POST" }));
    noStore(response);
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(cookies);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(session);
  });

  it("preserves an immutable provider redirect", async () => {
    auth.handler.mockResolvedValue(Response.redirect(`${ORIGIN}/hq/welcome`, 302));
    const response = await GET(new Request(`${ORIGIN}/api/auth/callback/telegram`));
    noStore(response);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/hq/welcome`);
    expect(await response.text()).toBe("");
  });

  it("keeps an upstream error and retry headers after a delivery failure", async () => {
    auth.handler.mockImplementation(async () => {
      memberEmailDeliveryFailed();
      return Response.json({ code: "TOO_MANY_REQUESTS" }, {
        status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "60" },
      });
    });
    const response = await POST(new Request(`${ORIGIN}/api/auth/email-otp/send-verification-otp`, { method: "POST" }));
    noStore(response);
    expect(response.status).toBe(429);
    expect(response.statusText).toBe("Too Many Requests");
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({ code: "TOO_MANY_REQUESTS" });
  });

  it.each([GET, POST])("does not cache missing-auth configuration errors (%#)", async (handle) => {
    auth.getAuth.mockImplementation(() => { throw new MemberAuthUnavailableError(); });
    const response = await handle(new Request(`${ORIGIN}/api/auth/get-session`));
    noStore(response);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "AUTH_UNAVAILABLE" });
    expect(auth.handler).not.toHaveBeenCalled();
  });

  it("keeps the delivery failure response instead of reporting a successful OTP send", async () => {
    auth.handler.mockImplementation(async () => {
      memberEmailDeliveryFailed();
      return Response.json({ success: true });
    });
    const response = await POST(new Request(`${ORIGIN}/api/auth/email-otp/send-verification-otp`, { method: "POST" }));
    noStore(response);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "EMAIL_DELIVERY_FAILED", message: "We could not send your code. Please try again shortly.",
    });
  });

  it("isolates a daily quota failure from another in-flight auth request", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    auth.handler.mockImplementation(async (request) => {
      if (request.method === "POST") {
        memberEmailDeliveryFailed("EMAIL_DAILY_QUOTA_EXCEEDED");
        release();
        await Promise.resolve();
        return Response.json({ success: true });
      }
      await ready;
      return Response.json(null);
    });
    const [quota, session] = await Promise.all([
      POST(new Request(`${ORIGIN}/api/auth/email-otp/send-verification-otp`, { method: "POST" })),
      GET(new Request(`${ORIGIN}/api/auth/get-session`)),
    ]);
    expect(quota.status).toBe(429);
    expect((await quota.json()).code).toBe("EMAIL_DAILY_QUOTA_EXCEEDED");
    expect(session.status).toBe(200);
    expect(await session.json()).toBeNull();
    noStore(quota);
    noStore(session);
  });
});
