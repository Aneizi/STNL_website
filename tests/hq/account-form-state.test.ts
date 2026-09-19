import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ state: [] as unknown[], position: 0, send: vi.fn(), social: vi.fn(), cooldown: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = mocks.position++;
    if (!(index in mocks.state)) mocks.state[index] = initial;
    return [mocks.state[index], (value: unknown) => { mocks.state[index] = value; }];
  },
  useEffect: () => {},
  useRef: () => ({ current: null }),
}));
vi.mock("@/lib/hq/member-auth-client", () => ({ memberAuthClient: {
  emailOtp: { sendVerificationOtp: mocks.send }, signIn: { social: mocks.social },
} }));
vi.mock("@/app/hq/(member)/use-resend-cooldown", () => ({ useResendCooldown: () => ({ secondsLeft: 0, startCooldown: mocks.cooldown }) }));
vi.mock("symbols-react", () => ({ IconArrowRight: () => null, IconPaperplaneFill: () => null }));

import { AccountForm } from "@/app/hq/(member)/account-form";
import { emailChangeErrorMessage } from "@/app/hq/(member)/account/email-copy";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : "";
}
function render(telegram = true) {
  mocks.position = 0;
  return elements(AccountForm({ next: "/hq/invite/continue", availability: { configured: true, email: true, telegram } }));
}
const find = (tree: Element[], predicate: (element: Element) => boolean) => {
  const element = tree.find(predicate);
  if (!element) throw new Error("Missing form control");
  return element;
};
const button = (tree: Element[], label: string) => find(tree, (element) => element.type === "button" && text(element) === label);
const alert = (tree: Element[]) => text(find(tree, (element) => element.props.role === "alert"));
const submit = { preventDefault() {} };
async function send(telegram = true) {
  let tree = render(telegram);
  (find(tree, (element) => element.props.name === "email").props.onChange as (event: unknown) => void)({ target: { value: "member@example.test" } });
  tree = render(telegram);
  await (find(tree, (element) => element.type === "form").props.onSubmit as (event: unknown) => Promise<void>)(submit);
  return render(telegram);
}

beforeEach(() => { vi.resetAllMocks(); mocks.state = []; });

describe("email quota guidance", () => {
  it("keeps sign-in choices open and offers Telegram when the first code hits the daily quota", async () => {
    mocks.send.mockResolvedValue({ error: { status: 429, code: "EMAIL_DAILY_QUOTA_EXCEEDED" } });
    const tree = await send();
    expect(alert(tree)).toBe("We've reached our daily email limit. Continue with Telegram or try again tomorrow.");
    expect(button(tree, "Continue with Telegram").props.disabled).toBe(false);
    expect(button(tree, "Continue with email").props.disabled).toBe(false);
    expect(mocks.cooldown).not.toHaveBeenCalled();
  });

  it("offers Telegram after a failed resend and preserves the invitation destination", async () => {
    mocks.send.mockResolvedValueOnce({}).mockResolvedValueOnce({ error: { status: 429, code: "EMAIL_DAILY_QUOTA_EXCEEDED" } });
    let tree = await send();
    expect(text(find(tree, (element) => element.type === "h1"))).toBe("Check your email");
    const resend = find(tree, (element) => typeof element.type === "function" && element.type.name === "ResendCodeButton");
    await (resend.props.onClick as () => Promise<void>)();
    tree = render();
    expect(alert(tree)).toContain("Continue with Telegram or try again tomorrow");
    expect(text(find(tree, (element) => element.props.id === "code-status"))).toBe("");
    expect(mocks.cooldown).toHaveBeenCalledOnce();
    mocks.social.mockResolvedValue({});
    await (button(tree, "Continue with Telegram").props.onClick as () => Promise<void>)();
    expect(mocks.social).toHaveBeenCalledWith(expect.objectContaining({ provider: "telegram", callbackURL: "/hq/invite/continue", newUserCallbackURL: "/hq/profile?next=%2Fhq%2Finvite%2Fcontinue" }));
  });

  it("does not suggest Telegram when that provider is unavailable", async () => {
    mocks.send.mockResolvedValue({ error: { status: 429, code: "EMAIL_DAILY_QUOTA_EXCEEDED" } });
    expect(alert(await send(false))).toBe("We've reached our daily email limit. Please try again tomorrow.");
  });

  it("keeps short-term attempt limits distinct from the daily email quota", async () => {
    mocks.send.mockResolvedValue({ error: { status: 429, code: "TOO_MANY_REQUESTS" } });
    expect(alert(await send())).toBe("Too many attempts. Please wait a minute and try again.");
    expect(emailChangeErrorMessage({ status: 429, code: "EMAIL_DAILY_QUOTA_EXCEEDED" }, "fallback")).toBe("We've reached our daily email limit. Please try again tomorrow.");
    expect(emailChangeErrorMessage({ status: 429, code: "TOO_MANY_REQUESTS" }, "fallback")).toBe("Too many attempts. Please wait a minute and try again.");
  });
});
