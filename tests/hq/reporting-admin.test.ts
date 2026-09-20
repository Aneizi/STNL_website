// The Admin page's three reporting sections, rendered against the design's
// copy: the date-driven week pills, the settings' kickers and tri-state
// materials, and the reminder history's three pills with their comma
// phrases. Static markup only: what the server sends is what is checked.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReportingAdminData } from "@/lib/hq/builder-admin-queries";
import type { ReminderDeliveryView } from "@/lib/hq/jobs";
import type { ReportingPeriod } from "@/lib/hq/reporting";

vi.mock("@/components/hq/toast", () => ({ showToast: vi.fn() }));
vi.mock("@/lib/hq/actions/jobs", () => ({ loadMoreReminderDeliveries: vi.fn(), runReportingJobsNow: vi.fn(), resendCaptainReminder: vi.fn() }));
vi.mock("@/lib/hq/actions/reporting-admin", () => ({ applyReportingSchedule: vi.fn(), readColosseumDeadline: vi.fn(), saveReportingConfiguration: vi.fn() }));

import { ReportingAdmin } from "@/components/hq/reporting-admin";

const AMSTERDAM = "Europe/Amsterdam";

function period(sequence: number, startDate: string, endDate: string, mode: ReportingPeriod["mode"] = "weekly"): ReportingPeriod {
  return {
    id: `period-${sequence}`, hackathonId: 6, sequence, mode, startDate, endDate,
    startsAt: `${startDate}T00:00:00+02:00`, endsAt: `${endDate}T24:00:00+02:00`, nudgeAt: null, closedAt: null,
  };
}

function reminder(overrides: Partial<ReminderDeliveryView> & Pick<ReminderDeliveryView, "id" | "captainName" | "state">): ReminderDeliveryView {
  return {
    outgoingId: null, canResend: false,
    captainUserId: `user-${overrides.id}`, hackathonId: 6, periodId: "period-1", periodSequence: 1,
    periodStartDate: "2026-09-14", periodEndDate: "2026-09-20", reminderType: "weekly_nudge", dueAt: "2026-09-16T10:00:00.000Z",
    reason: null, projectCount: 1, providerMessageId: null, attempts: 1, lastError: null, nextAttemptAt: null,
    deliveryUncertain: false, createdAt: "2026-09-16T10:00:00.000Z", resolvedAt: null,
    ...overrides,
  };
}

const data: ReportingAdminData = {
  hackathonId: 6,
  hackathonName: "Colosseum Crypto World's Fair",
  schedule: { startDate: "2026-09-14", endDate: "2026-10-12", timezone: AMSTERDAM, finalPeriodStartDate: "2026-10-05", nudgeWeekday: 3, nudgeTime: "12:00" },
  config: {
    hackathonId: 6, finalPeriodStartDate: "2026-10-05", officialSubmissionDeadline: "2026-10-12T16:00:00.000Z",
    officialDeadlineSource: "admin", officialDeadlineCheckedAt: null,
    requiredMaterials: ["repo", "demoVideo"], optionalMaterials: ["presentation"], submissionRefreshMinutes: null,
    nudgeWeekday: 3, nudgeTime: "12:00", stored: true,
  },
  plan: {
    periods: [
      period(1, "2026-09-14", "2026-09-20"), period(2, "2026-09-21", "2026-09-27"),
      period(3, "2026-09-28", "2026-10-04"), period(4, "2026-10-05", "2026-10-12", "submission"),
    ],
    added: 0, updated: 0, removed: 0, conflicts: [], blocked: false, problems: [],
  },
  enrolled: 7,
  paused: 1,
  reminders: [
    reminder({ id: "r1", captainName: "Femke de Jong", state: "sent" }),
    reminder({ id: "r2", captainName: "Joost Vermeer", state: "skipped", reason: "messaging_disabled", projectCount: 2, attempts: 0 }),
    reminder({ id: "r3", captainName: "Lotte Bakker", state: "queued", deliveryUncertain: true, nextAttemptAt: "2026-09-16T18:00:00.000Z" }),
  ],
  botConfigured: true,
  today: "2026-09-23",
};

const render = (override: Partial<ReportingAdminData> = {}) => renderToStaticMarkup(createElement(ReportingAdmin, { data: { ...data, ...override } }));

describe("Reporting weeks", () => {
  it("lists the weeks with their short ranges and a pill decided by today's date", () => {
    const html = render();
    expect(html).toContain("Reporting weeks");
    expect(html).toContain("7 projects report, 1 paused.");
    expect(html).toContain("14 Sep to 20 Sep");
    expect(html).toContain("28 Sep to 4 Oct");
    expect(html.match(/Final submission period/g)).toHaveLength(1);
    // 23 September: week one is over, week two is running, the rest have not started.
    expect(html.match(/>(Closed|Open|Upcoming)</g)).toEqual([">Closed<", ">Open<", ">Upcoming<", ">Upcoming<"]);
    expect(html).toContain("Apply hackathon dates");
    expect(html).toContain("Weeks already match the hackathon dates.");
  });

  it("says what applying would do, and that a refused change is refused", () => {
    expect(render({ plan: { ...data.plan, added: 1, updated: 2 } })).toContain("Applying the hackathon dates would add 1 week, move 2 weeks.");
    expect(render({ plan: { ...data.plan, removed: 1, blocked: true } }))
      .toContain("Applying the hackathon dates would remove 1 week. Refused, because it would leave a day in no week or in two.");
    expect(render({ enrolled: 1, paused: 0 })).toContain("1 project reports, 0 paused.");
  });
});

describe("Reporting settings", () => {
  it("shows the kickers, the deadline in the campaign timezone and one selected requirement per material", () => {
    const html = render();
    for (const copy of [
      "Reporting settings", "Final period starts", "Reminder day", "Reminder time", "Auto-check submissions", "Minutes, final period only",
      "Colosseum deadline", "Read from Colosseum", "Colosseum&#x27;s cutoff. Does not move the weeks.", "Submission materials", "Save settings",
      "Presentation or pitch deck", "Code repository", "Project website",
    ]) expect(html, copy).toContain(copy);
    // 16:00 UTC on 12 October is 18:00 in Amsterdam, and the field carries no offset of its own.
    expect(html).toMatch(/name="officialDeadline"[^>]*value="2026-10-12T18:00"/);
    expect(html).toMatch(/placeholder="Off"/);
    // Six materials, one pressed button each: two Required, one Optional, three Not known.
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(6);
    expect(html.match(/aria-pressed="true"[^>]*>Required</g)).toHaveLength(2);
    expect(html.match(/aria-pressed="true"[^>]*>Optional</g)).toHaveLength(1);
    expect(html.match(/aria-pressed="true"[^>]*>Not known</g)).toHaveLength(3);
    expect(html).toMatch(/<option[^>]*selected[^>]*value="3"|value="3"[^>]*selected/);
  });
});

describe("Captain reminders", () => {
  it("offers a per-Captain resend only for eligible reminders, and disables sending without a bot", () => {
    const reminders = [
      reminder({ id: "r1", captainName: "Femke de Jong", state: "sent" }),
      reminder({ id: "r2", captainName: "Joost Vermeer", state: "skipped", reason: "messaging_disabled", canResend: true }),
      reminder({ id: "r3", captainName: "Lotte Bakker", state: "queued", deliveryUncertain: true }),
    ];
    const html = render({ reminders });
    expect(html.match(/>Resend Telegram</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Resend Telegram reminder to Joost Vermeer for week 1"');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="Resend/);
    expect(render({ reminders, botConfigured: false })).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Resend/);
  });

  it("names the reminder day, and renders each delivery as a comma phrase with one of three pills", () => {
    const html = render();
    expect(html).toContain("Captain reminders");
    expect(html).toContain("Each Wednesday, Captains are told which teams still owe an update.");
    expect(html).toContain("Run now");
    expect(html).toContain("Femke de Jong");
    expect(html).toContain("Week 1, 1 team outstanding</span>");
    expect(html).toContain("Week 1, 2 teams outstanding, bot messages turned off");
    expect(html).toContain("Week 1, 1 team outstanding, no answer from Telegram, retry 16 Sep 20:00");
    expect(html.match(/>(Sent|Not sent|Retrying)</g)).toEqual([">Sent<", ">Not sent<", ">Retrying<"]);
    expect(html).toContain("Show earlier reminders");
  });

  it("falls back to the day set above when the weekday is unknown, and to Telegram's code for a reason without a phrase", () => {
    const html = render({
      config: { ...data.config, nudgeWeekday: 0 },
      reminders: [reminder({ id: "r9", captainName: "Sanne Mulder", state: "failed", reason: "chat_not_found" })],
    });
    expect(html).toContain("Each the day set above, Captains are told");
    expect(html).toContain("Week 1, 1 team outstanding, Telegram refused it (chat_not_found)");
    expect(html).toContain(">Not sent<");
  });

  it("uses none of the forbidden characters anywhere in the markup", () => {
    expect(render()).not.toMatch(/[—·]/);
  });
});
