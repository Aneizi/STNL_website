import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), requireHackathon: vi.fn(), config: vi.fn(), retry: vi.fn(),
  list: vi.fn(), flush: vi.fn(), reconcile: vi.fn(), refresh: vi.fn(),
  db: { query: vi.fn() }, sender: { sendMessage: vi.fn() },
}));
vi.mock("@/lib/hq/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/hq/hackathon", () => ({ requireHackathon: mocks.requireHackathon }));
vi.mock("@/lib/hq/builder-db", () => ({ builderDatabase: () => mocks.db }));
vi.mock("@/lib/hq/jobs", () => ({ retryReminder: mocks.retry, listReminderDeliveries: mocks.list, reconcileReminderDeliveries: mocks.reconcile, runDueWork: vi.fn() }));
vi.mock("@/lib/hq/telegram-bot-api", () => ({ telegramBotConfig: mocks.config, telegramSender: () => mocks.sender, isTelegramBotConfigured: () => true }));
vi.mock("@/lib/hq/telegram-bot-store", () => ({ flushBotMessages: mocks.flush }));
vi.mock("@/lib/hq/actions/util", () => ({ refreshHq: mocks.refresh }));

import { resendCaptainReminder } from "@/lib/hq/actions/jobs";

const deliveryId = "00000000-0000-4000-8000-000000000001";
const outgoingId = "00000000-0000-4000-8000-000000000002";
const input = { deliveryId, expectedOutgoingId: null };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "operator" });
  mocks.requireHackathon.mockResolvedValue({ id: 71 });
  mocks.config.mockReturnValue({ token: "test" });
  mocks.retry.mockResolvedValue({ ok: true, state: "queued", deliveryId, outgoingId, projects: 1 });
  mocks.list.mockResolvedValue([{ id: deliveryId, state: "sent", outgoingId, canResend: false }]);
});

describe("resendCaptainReminder operator action", () => {
  it("uses the server's selected edition, sends only the new attempt and returns its refreshed status", async () => {
    expect(await resendCaptainReminder(input)).toMatchObject({ ok: true, delivery: { id: deliveryId, state: "sent" } });
    expect(mocks.retry).toHaveBeenCalledWith(mocks.db, { ...input, hackathonId: 71 });
    expect(mocks.flush).toHaveBeenCalledWith(mocks.db, mocks.sender, { outgoingId, limit: 1 });
    expect(mocks.reconcile).toHaveBeenCalledWith(mocks.db);
    expect(mocks.list).toHaveBeenCalledWith(mocks.db, { hackathonId: 71, deliveryId });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("requires an operator session before preparing or sending", async () => {
    mocks.requireUser.mockRejectedValue(new Error("Unauthorized"));
    await expect(resendCaptainReminder(input)).rejects.toThrow("Unauthorized");
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it("rejects invalid input before touching the queue", async () => {
    expect(await resendCaptainReminder({ ...input, deliveryId: "bad" })).toMatchObject({ ok: false });
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it("leaves the reminder untouched if the bot is not configured", async () => {
    mocks.config.mockReturnValue(null);
    expect(await resendCaptainReminder(input)).toEqual({ ok: false, error: "The Telegram bot is not configured." });
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it("returns the current skip reason without calling Telegram when notifications are still off", async () => {
    mocks.retry.mockResolvedValue({ ok: true, state: "skipped", deliveryId, reason: "messaging_disabled" });
    mocks.list.mockResolvedValue([{ id: deliveryId, state: "skipped", reason: "messaging_disabled", canResend: true }]);
    expect(await resendCaptainReminder(input)).toMatchObject({ ok: true, delivery: { state: "skipped", reason: "messaging_disabled" } });
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it.each(["not_found", "not_due", "not_retryable", "changed"])("reports %s without a send", async (reason) => {
    mocks.retry.mockResolvedValue({ ok: false, reason });
    expect(await resendCaptainReminder(input)).toMatchObject({ ok: false, error: expect.any(String) });
    expect(mocks.flush).not.toHaveBeenCalled();
  });
});
