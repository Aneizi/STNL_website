import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ state: [] as unknown[], position: 0, guideDone: false, work: null as Promise<unknown> | null, save: vi.fn(), refresh: vi.fn(), open: vi.fn(), close: vi.fn(), navigate: vi.fn(), navigateHq: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = mocks.position++;
    if (!(index in mocks.state)) mocks.state[index] = initial;
    return [mocks.state[index], (value: unknown) => { mocks.state[index] = value; }];
  },
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useTransition: () => [false, (work: () => Promise<unknown>) => { mocks.work = work(); }],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/hq/actions/telegram", () => ({ confirmEmailChange: vi.fn(), confirmLinkTelegram: vi.fn(), confirmUnlinkTelegram: vi.fn(), setBotMessaging: mocks.save }));
vi.mock("@/lib/hq/member-auth-client", () => ({ memberAuthClient: {} }));
vi.mock("@/components/hq/builder-account-menu", () => ({ useMemberAccount: () => ({ id: 'test-account' }) }));
vi.mock("@/components/hq/use-reminder-guide", () => ({ useReminderGuide: (_userId: unknown, step: string) => ({ visible: !mocks.guideDone, animate: true, dismiss() { if (step === 'reminders') mocks.guideDone = true; }, finishBounce() {} }) }));
vi.mock("@/app/hq/(member)/use-resend-cooldown", () => ({ useResendCooldown: () => ({ secondsLeft: 0, startCooldown() {} }) }));
vi.mock("symbols-react", () => ({ IconArrowLeft: () => null, IconArrowRight: () => null }));

import { AccountPassport, type AccountPassportProps } from "@/app/hq/(member)/account/account-passport";

const base: AccountPassportProps = {
  name: "Test Builder", role: "User", email: null, hasEmail: false, telegram: { username: "test_builder" }, teamName: null,
  bot: false, botUrl: "https://t.me/fixture_bot", emailAvailable: true, telegramAvailable: true, initialNotice: null, initialError: null,
};
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function render(props: Partial<AccountPassportProps> = {}) {
  mocks.position = 0;
  return elements(AccountPassport({ ...base, ...props }));
}
function toggle(tree: Element[], enabled: boolean) {
  const input = tree.find(element => element.props.type === "checkbox")!;
  (input.props.onChange as (event: unknown) => void)({ target: { checked: enabled } });
}

beforeEach(() => {
  vi.resetAllMocks(); mocks.state = []; mocks.work = null; mocks.guideDone = false;
  mocks.open.mockReturnValue({ opener: {}, closed: false, location: { replace: mocks.navigate }, close: mocks.close });
  vi.stubGlobal("window", { open: mocks.open, location: { assign: mocks.navigateHq } });
});
afterEach(() => vi.unstubAllGlobals());

describe("enabling Telegram reminders", () => {
  it("opens a separate tab during the click and loads Telegram only after consent is saved", async () => {
    let finish!: (value: unknown) => void;
    mocks.save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    toggle(render(), true);
    expect(render().some(element => String(element.props.className).includes('switchArrows'))).toBe(false);
    expect(mocks.save).toHaveBeenCalledWith(true);
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
    expect(mocks.open.mock.invocationCallOrder[0]).toBeLessThan(mocks.save.mock.invocationCallOrder[0]);
    expect(mocks.open.mock.results[0].value.opener).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
    finish({ ok: true, enabled: true });
    await mocks.work;
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(base.botUrl);
    expect(mocks.navigateHq).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(render().find(element => element.props.type === "checkbox")?.props.checked).toBe(true);
  });

  it.each(["refused", "offline"])("keeps the user in HQ and restores the switch when saving is %s", async (failure) => {
    if (failure === "offline") mocks.save.mockRejectedValue(new Error("offline"));
    else mocks.save.mockResolvedValue({ ok: false, code: "TELEGRAM_NOT_CONNECTED" });
    toggle(render(), true);
    await mocks.work;
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.navigateHq).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
    const tree = render();
    expect(tree.find(element => element.props.type === "checkbox")?.props.checked).toBe(false);
    expect(tree.find(element => element.props.role === "alert")).toBeDefined();
    expect(tree.some(element => String(element.props.className).includes('switchArrows'))).toBe(false);
  });

  it("does not open Telegram when disabling reminders", async () => {
    mocks.save.mockResolvedValue({ ok: true, enabled: false });
    toggle(render({ bot: true }), false);
    await mocks.work;
    expect(mocks.save).toHaveBeenCalledWith(false);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("does not bring the arrows back after enabling and then disabling reminders", async () => {
    mocks.save.mockImplementation(async enabled => ({ ok: true, enabled }));
    toggle(render(), true);
    await mocks.work;
    toggle(render(), false);
    await mocks.work;
    expect(render().some(element => String(element.props.className).includes('switchArrows'))).toBe(false);
  });

  it("still saves when no bot link is configured", async () => {
    mocks.save.mockResolvedValue({ ok: true, enabled: true });
    toggle(render({ botUrl: null }), true);
    await mocks.work;
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(render({ botUrl: null }).find(element => element.props.type === "checkbox")?.props.checked).toBe(true);
  });

  it("keeps consent enabled and stays in HQ if the browser blocks the new tab", async () => {
    mocks.open.mockReturnValue(null);
    mocks.save.mockResolvedValue({ ok: true, enabled: true });
    toggle(render(), true);
    await mocks.work;
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.navigateHq).not.toHaveBeenCalled();
    expect(render().find(element => element.props.type === "checkbox")?.props.checked).toBe(true);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("does not undo saved consent when the new tab can no longer be navigated", async () => {
    mocks.navigate.mockImplementation(() => { throw new Error("tab unavailable"); });
    mocks.save.mockResolvedValue({ ok: true, enabled: true });
    toggle(render(), true);
    await mocks.work;
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.navigateHq).not.toHaveBeenCalled();
    expect(render().find(element => element.props.type === "checkbox")?.props.checked).toBe(true);
    expect(render().find(element => element.props.role === "alert")).toBeUndefined();
  });
});
