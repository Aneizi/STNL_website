import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PeriodStatus, ReportingEntryView } from "@/lib/hq/reporting";

const action = vi.hoisted(() => ({ add: vi.fn(), edit: vi.fn() }));
// Preserve hook state across direct component renders to exercise draft
// behavior independently of a browser or a new DOM testing dependency.
const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, pending: [] as Promise<void>[] }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState<T>(initial: T | (() => T)) {
      if (!hooks.active) return actual.useState(initial);
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.values[index] as T, (value: T | ((previous: T) => T)) => {
        hooks.values[index] = typeof value === "function" ? (value as (previous: T) => T)(hooks.values[index] as T) : value;
      }];
    },
    useTransition() {
      if (!hooks.active) return actual.useTransition();
      return [false, (work: () => Promise<void>) => { hooks.pending.push(work()); }];
    },
  };
});
vi.mock("@/lib/hq/actions/reporting-admin", () => ({ addAdminReportingUpdate: action.add, editAdminReportingUpdate: action.edit }));
vi.mock("@/components/hq/toast", () => ({ showToast: vi.fn() }));

import { AdminUpdateForm } from "@/components/hq/reporting-project-panel";

function period(sequence: number, closed: boolean): PeriodStatus {
  return {
    periodId: `week-${sequence}`, periodSequence: sequence, mode: "weekly",
    startDate: "2026-09-14", endDate: "2026-09-20", startsAt: "2026-09-13T22:00:00Z", endsAt: "2026-09-20T22:00:00Z",
    nudgeAt: null, completed: false, basis: "none", entries: 0, latestEntryAt: null, closed, exempt: false,
  };
}

const current = period(2, false);
const history = [period(3, false), current, period(1, true)];
const entry: ReportingEntryView = {
  id: "entry", projectId: "project", periodId: "week-1", periodSequence: 1,
  body: "A saved update", visibility: "sensitive", source: "hq", version: 3,
  late: false, edited: true, submittedAt: "2026-09-14T10:00:00Z", updatedAt: "2026-09-14T11:00:00Z",
  authorName: "Captain", authorIsYou: false, canEdit: true, voided: false,
};

afterEach(() => {
  hooks.active = false;
  hooks.values = [];
  hooks.cursor = 0;
  hooks.pending = [];
  vi.clearAllMocks();
});

function control(node: ReactNode, type: string): { onChange: (event: { target: { value: string } }) => void } | undefined {
  if (Array.isArray(node)) return node.map(child => control(child, type)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; onChange: (event: { target: { value: string } }) => void }>(node)) return;
  if (node.type === type) return node.props;
  return control(node.props.children, type);
}

describe("operator reporting composer", () => {
  it("offers the current and previous weeks, labels late entries, and omits future weeks", () => {
    const html = renderToStaticMarkup(createElement(AdminUpdateForm, { projectId: "project", detail: { current, history }, onDone: () => {} }));
    expect(html).toContain('value="week-2"');
    expect(html).toContain('value="week-1"');
    expect(html).toContain("late update");
    expect(html).not.toContain('value="week-3"');
    expect(html).toContain('maxLength="4000"');
    expect(html).not.toContain('type="checkbox"');
  });

  it("allows a labelled late update after the campaign ends", () => {
    const html = renderToStaticMarkup(createElement(AdminUpdateForm, { projectId: "project", detail: { current: null, history: [period(1, true)] }, onDone: () => {} }));
    expect(html).toContain("does not erase a missed week");
    expect(html).toContain("Add late update");
  });

  it("keeps the saved sensitive text and audience when editing without moving its period", () => {
    const html = renderToStaticMarkup(createElement(AdminUpdateForm, { projectId: "project", detail: { current, history }, entry, onDone: () => {}, onCancel: () => {} }));
    expect(html).toContain("A saved update");
    expect(html).toContain('type="checkbox" checked=""');
    expect(html).toContain("original author and admins");
    expect(html).toContain("Save correction");
    expect(html).not.toContain("<select");
  });

  it("keeps the editor's original version after props refresh, then uses an explicitly reported conflict version", async () => {
    hooks.active = true;
    const props = { projectId: "project", detail: { current, history }, entry, onDone: () => {} };
    let form = AdminUpdateForm(props);
    control(form, "textarea")!.onChange({ target: { value: "My unsaved correction" } });
    hooks.cursor = 0;
    const fresh = { ...entry, version: 4, body: "Somebody else's newer text" };
    form = AdminUpdateForm({ ...props, entry: fresh });
    action.edit.mockResolvedValueOnce({ ok: false, reason: "conflict", error: "Changed", current: fresh });
    form.props.onSubmit({ preventDefault() {} });
    await Promise.all(hooks.pending);
    expect(action.edit).toHaveBeenLastCalledWith(expect.objectContaining({ body: "My unsaved correction", expectedVersion: 3 }));
    hooks.cursor = 0;
    form = AdminUpdateForm({ ...props, entry: { ...fresh, version: 5 } });
    action.edit.mockResolvedValueOnce({ ok: true, entry: fresh });
    form.props.onSubmit({ preventDefault() {} });
    await Promise.all(hooks.pending);
    expect(action.edit).toHaveBeenLastCalledWith(expect.objectContaining({ body: "My unsaved correction", expectedVersion: 4 }));
  });

  it("does not turn an open-week draft into a late save when props refresh into the next week", async () => {
    hooks.active = true;
    const props = { projectId: "project", detail: { current, history }, onDone: () => {} };
    let form = AdminUpdateForm(props);
    control(form, "textarea")!.onChange({ target: { value: "Draft for this week" } });
    hooks.cursor = 0;
    const refreshed = { ...props, detail: { current: period(3, false), history: [period(3, false), period(2, true), period(1, true)] } };
    form = AdminUpdateForm(refreshed);
    action.add.mockResolvedValue({ ok: false, reason: "period_changed", error: "Choose a week", currentPeriod: { id: "week-3", sequence: 3 } });
    form.props.onSubmit({ preventDefault() {} });
    await Promise.all(hooks.pending);
    expect(action.add).toHaveBeenLastCalledWith({ projectId: "project", body: "Draft for this week", visibility: "shared", expectedPeriodId: "week-2" });
    hooks.cursor = 0;
    form = AdminUpdateForm(refreshed);
    control(form, "select")!.onChange({ target: { value: "week-2" } });
    hooks.cursor = 0;
    form = AdminUpdateForm(refreshed);
    form.props.onSubmit({ preventDefault() {} });
    await Promise.all(hooks.pending);
    expect(action.add).toHaveBeenLastCalledWith({ projectId: "project", body: "Draft for this week", visibility: "shared", periodId: "week-2" });
  });
});
