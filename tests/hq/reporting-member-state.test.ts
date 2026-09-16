import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportingEntryView } from "@/lib/hq/reporting";
import type { TeamPeriodView, TeamReportingPanel } from "@/lib/hq/reporting-surface";

type Element = ReactElement<Record<string, unknown>>;
type Component = (props: Record<string, unknown>) => ReactNode;
type Effect = { dependencies: readonly unknown[]; run: () => void | (() => void); cleanup?: () => void };

const mocks = vi.hoisted(() => ({
  hooks: null as Hooks | null,
  work: [] as Promise<unknown>[],
  refresh: vi.fn(), add: vi.fn(), edit: vi.fn(), load: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/hq/actions/reporting", () => ({
  addReportingUpdate: mocks.add, editReportingUpdate: mocks.edit, loadTeamUpdates: mocks.load,
  saveCaptainContact: vi.fn(), saveTeamContact: vi.fn(),
}));
vi.mock("@/components/hq/submission-focus", () => ({ SubmissionFocus: () => null }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => mocks.hooks!.state(initial),
  useRef: (initial: unknown) => mocks.hooks!.state(() => ({ current: initial }))[0],
  useCallback: (callback: unknown, dependencies: readonly unknown[]) => mocks.hooks!.memo(callback, dependencies),
  useEffect: (run: Effect["run"], dependencies: readonly unknown[]) => mocks.hooks!.effect(run, dependencies),
  useTransition: () => [false, (run: () => Promise<unknown>) => { mocks.work.push(run()); }],
}));

import { CaptainProjectCard, TeamReporting, type CaptainCardProps } from "@/components/hq/reporting-member";

function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

/** Exercise the real event handlers across renders without adding a DOM/runtime dependency.
 * Only React's hook storage and effect scheduling are replaced; these tests do not assert browser behavior. */
class Hooks {
  slots: unknown[] = [];
  position = 0;
  dirty = false;
  effects = new Map<number, Effect>();
  pendingEffects = new Map<number, Effect>();
  tree: ReactNode = null;
  constructor(readonly component: Component, public props: Record<string, unknown>) {}
  state(initial: unknown): [unknown, (next: unknown) => void] {
    const index = this.position++;
    if (!(index in this.slots)) this.slots[index] = typeof initial === "function" ? initial() : initial;
    return [this.slots[index], (next) => {
      const value = typeof next === "function" ? next(this.slots[index]) : next;
      if (!Object.is(this.slots[index], value)) { this.slots[index] = value; this.dirty = true; }
    }];
  }
  memo(value: unknown, dependencies: readonly unknown[]) {
    const index = this.position++;
    const old = this.slots[index] as { value: unknown; dependencies: readonly unknown[] } | undefined;
    if (!old || dependencies.some((item, i) => !Object.is(item, old.dependencies[i]))) this.slots[index] = { value, dependencies };
    return (this.slots[index] as { value: unknown }).value;
  }
  effect(run: Effect["run"], dependencies: readonly unknown[]) {
    const index = this.position++;
    const old = this.effects.get(index);
    if (!old || dependencies.some((item, i) => !Object.is(item, old.dependencies[i]))) this.pendingEffects.set(index, { run, dependencies });
  }
  render(props = this.props) {
    this.props = props;
    mocks.hooks = this;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      this.position = 0; this.dirty = false; this.pendingEffects.clear();
      this.tree = this.component(props);
      if (!this.dirty) break;
    }
    for (const [index, effect] of this.pendingEffects) {
      this.effects.get(index)?.cleanup?.();
      effect.cleanup = effect.run() || undefined;
      this.effects.set(index, effect);
    }
    return this;
  }
  find(type: string, label?: string): Element {
    const found = elements(this.tree).find((element) =>
      (element.type === type || (typeof element.type === "function" && element.type.name === type)) &&
      (label === undefined || element.props.children === label),
    );
    if (!found) throw new Error(`Missing ${type} ${label ?? ""}`);
    return found;
  }
  event(type: string, event: string, value?: unknown, label?: string) {
    const handler = this.find(type, label).props[event] as (value: unknown) => void;
    handler(value);
    return this.render();
  }
  entries() { return elements(this.tree).filter((element) => typeof element.type === "function" && element.type.name === "Entry").map((element) => element.props.entry as ReportingEntryView); }
}

const week = (id: string, sequence = 1): TeamPeriodView => ({
  periodId: id, periodSequence: sequence, startDate: "2026-09-14", endDate: "2026-09-20",
  startsAt: "2026-09-13T22:00:00Z", endsAt: sequence === 1 ? "2026-09-20T22:00:00Z" : "2026-09-27T22:00:00Z", completed: false,
});
const entry = (id: string, version = 1, periodId = "week-1"): ReportingEntryView => ({
  id, version, periodId, periodSequence: 1, projectId: "project", body: `Body ${id} v${version}`, visibility: "shared", source: "hq",
  canEdit: true, authorIsYou: true, authorName: "Captain", submittedAt: "2026-09-15T12:00:00Z", updatedAt: "2026-09-15T12:00:00Z",
  late: false, edited: version > 1, voided: false,
});

function component(name: string, overrides: Partial<CaptainCardProps> = {}): Component {
  const card = CaptainProjectCard({ projectId: "project", projectName: "Team", hackathonId: 1, current: week("week-1"),
    missedPeriods: 0, paused: false, teamContact: null, weeks: [week("week-1")], entries: [], nextCursor: null,
    timezone: "Europe/Amsterdam", nowMs: Date.parse("2026-10-01T12:00:00Z"), ...overrides });
  return elements(card).find((element) => typeof element.type === "function" && element.type.name === name)!.type as Component;
}
const list = (initial = [entry("a"), entry("b")], initialCursor: string | null = "older") => new Hooks(component("UpdateList"), {
  projectId: "project", hackathonId: 1, initial, initialCursor, weeks: [week("week-1"), week("week-2", 2)], canMarkSensitive: true,
}).render();
const composer = (late = false) => new Hooks(component("Composer"), { projectId: "project", hackathonId: 1, period: week("week-1"), label: "Your update", canMarkSensitive: false, late }).render();
const change = (value: string) => ({ target: { value } });
const submit = { preventDefault() {} };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { await Promise.all(mocks.work.splice(0)); await Promise.resolve(); await Promise.resolve(); }

beforeEach(() => { vi.clearAllMocks(); mocks.work = []; mocks.add.mockResolvedValue({ ok: true, entry: entry("new") }); });

describe("authorized list refreshes", () => {
  it("replaces the refreshed first page, discards old bodies and uses its new cursor", async () => {
    mocks.load.mockResolvedValue({ entries: [entry("older")], nextCursor: "oldest" });
    const view = list();
    view.event("button", "onClick", undefined, "Show older updates"); await settle(); view.render();
    expect(view.entries()).toHaveLength(3);
    view.render({ ...view.props, initial: [entry("a", 2)], initialCursor: "fresh-cursor" });
    expect(view.entries()).toEqual([entry("a", 2)]);
    view.event("button", "onClick", undefined, "Show older updates");
    expect(mocks.load).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "fresh-cursor" }));
    await settle();
  });

  it("keeps the chosen week but ignores stale responses after another refresh", async () => {
    const first = deferred<{ entries: ReportingEntryView[]; nextCursor: null }>();
    const stale = deferred<{ entries: ReportingEntryView[]; nextCursor: null }>();
    const fresh = deferred<{ entries: ReportingEntryView[]; nextCursor: null }>();
    mocks.load.mockReturnValueOnce(first.promise).mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const view = list();
    view.event("select", "onChange", change("week-1"));
    first.resolve({ entries: [entry("old-week")], nextCursor: null }); await settle(); view.render();
    view.render({ ...view.props, initial: [entry("new-first-page")] });
    expect(view.entries()).toEqual([]);
    view.render({ ...view.props, initial: [entry("newer-first-page")] });
    stale.resolve({ entries: [entry("now-sensitive")], nextCursor: null }); await settle(); view.render();
    expect(view.entries()).toEqual([]);
    fresh.resolve({ entries: [entry("authorized")], nextCursor: null }); await settle(); view.render();
    expect(view.find("select").props.value).toBe("week-1");
    expect(view.entries()).toEqual([entry("authorized")]);
    expect(mocks.load).toHaveBeenLastCalledWith(expect.objectContaining({ periodId: "week-1", cursor: undefined }));
  });

  it("offers a retry after the selected week's refreshed page cannot load", async () => {
    mocks.load.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ entries: [entry("recovered")], nextCursor: null });
    const view = list(); view.event("select", "onChange", change("week-1")); await settle(); view.render();
    expect(view.find("ErrorText").props.error).toContain("could not be loaded");
    expect(view.entries()).toEqual([]);
    view.event("button", "onClick", undefined, "Try again"); await settle(); view.render();
    expect(view.entries()).toEqual([entry("recovered")]);
  });

  it("shows completed edits immediately and never inserts one into another selected week", async () => {
    const pending = deferred<{ entries: ReportingEntryView[]; nextCursor: null }>();
    mocks.load.mockReturnValueOnce(pending.promise);
    const view = list();
    const saved = view.find("Entry").props.onSaved as (entry: ReportingEntryView) => void;
    saved(entry("a", 2)); view.render();
    expect(view.entries().find((entry) => entry.id === "a")?.version).toBe(2);
    view.event("select", "onChange", change("week-2"));
    saved(entry("a", 3)); view.render();
    expect(view.entries()).toEqual([]);
    pending.resolve({ entries: [entry("week-two", 1, "week-2")], nextCursor: null }); await settle(); view.render();
    expect(view.entries()).toEqual([entry("week-two", 1, "week-2")]);
  });
});

describe("drafts keep their original target", () => {
  it("keeps a draft after the final deadline and saves it late only when explicitly requested", async () => {
    expect(component("Composer", { current: null })).toBe(component("Composer"));
    const view = composer(); view.event("textarea", "onChange", change("Draft across the final deadline"));
    view.render({ ...view.props, period: null });
    expect(view.find("textarea").props.value).toBe("Draft across the final deadline");
    expect(mocks.add).not.toHaveBeenCalled();
    view.event("button", "onClick", undefined, "Add as a late update to its original week"); await settle(); view.render();
    expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ periodId: "week-1", body: "Draft across the final deadline" }));
    expect(mocks.add.mock.lastCall![0]).not.toHaveProperty("expectedPeriodId");
    expect(view.tree).toBeNull();
  });

  it("preserves a paused draft, refuses a save while paused, and keeps its target after resume", async () => {
    expect(component("Composer", { paused: true })).toBe(component("Composer"));
    const view = composer(); view.event("textarea", "onChange", change("Draft across a pause"));
    view.render({ ...view.props, paused: true });
    expect(view.find("textarea").props.value).toBe("Draft across a pause");
    view.event("form", "onSubmit", submit); await settle(); view.render();
    expect(mocks.add).not.toHaveBeenCalled();
    view.render({ ...view.props, paused: false, period: week("week-2", 2) });
    view.event("form", "onSubmit", submit); await settle();
    expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ expectedPeriodId: "week-1", body: "Draft across a pause" }));
  });

  it("keeps the typed draft's week across a refresh, and moves it only on explicit confirmation", async () => {
    const currentPeriod = { ...week("week-2", 2), id: "week-2", sequence: 2 };
    mocks.add.mockResolvedValueOnce({ ok: false, reason: "period_changed", error: "The week changed", currentPeriod }).mockResolvedValueOnce({ ok: true, entry: entry("saved") });
    const view = composer(); view.event("textarea", "onChange", change("My original draft"));
    view.render({ ...view.props, period: week("week-2", 2) });
    view.event("form", "onSubmit", submit); await settle(); view.render();
    expect(mocks.add).toHaveBeenLastCalledWith(expect.objectContaining({ expectedPeriodId: "week-1", body: "My original draft" }));
    expect(view.find("textarea").props.value).toBe("My original draft");
    view.event("button", "onClick", undefined, "Save it to this week"); await settle(); view.render();
    expect(mocks.add).toHaveBeenLastCalledWith(expect.objectContaining({ expectedPeriodId: "week-2" }));
    expect(view.find("textarea").props.value).toBe("");
    view.event("textarea", "onChange", change("A fresh draft")); view.event("form", "onSubmit", submit); await settle();
    expect(mocks.add).toHaveBeenLastCalledWith(expect.objectContaining({ expectedPeriodId: "week-2", body: "A fresh draft" }));
  });

  it("keeps an edit's opening version after its entry refreshes", async () => {
    const parent = list(); const node = parent.find("Entry");
    const view = new Hooks(node.type as Component, node.props).render();
    view.event("button", "onClick", undefined, "Edit this update"); view.event("textarea", "onChange", change("My edit"));
    view.render({ ...view.props, entry: entry("a", 2) });
    mocks.edit.mockResolvedValue({ ok: false, reason: "conflict", error: "Changed elsewhere", current: entry("a", 2) });
    view.event("form", "onSubmit", submit); await settle(); view.render();
    expect(mocks.edit).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1, body: "My edit" }));
    expect(view.find("textarea").props.value).toBe("My edit");
  });

  it("keeps the chosen late week when a newer week closes, and follows an explicit selection", async () => {
    const view = new Hooks(component("LateUpdateComposer"), { projectId: "project", hackathonId: 1, weeks: [week("week-1")], canMarkSensitive: false, nowMs: Date.parse("2026-10-01T12:00:00Z") }).render();
    view.render({ ...view.props, weeks: [week("week-1"), week("week-2", 2)] });
    expect(view.find("select").props.value).toBe("week-1");
    view.event("select", "onChange", change("week-2"));
    const draft = view.find("Composer");
    const late = new Hooks(draft.type as Component, draft.props).render();
    late.event("textarea", "onChange", change("Late update")); late.event("form", "onSubmit", submit); await settle();
    expect(mocks.add).toHaveBeenLastCalledWith(expect.objectContaining({ periodId: "week-2", body: "Late update" }));
    expect(mocks.add.mock.lastCall![0]).not.toHaveProperty("expectedPeriodId");
  });
});

describe("dashboard reporting disclosures", () => {
  const panel: TeamReportingPanel = {
    projectId: "project", hackathonId: 1, timezone: "Europe/Amsterdam", enrolled: true,
    paused: false, current: week("week-1"), missedPeriods: 0, history: [week("week-1")],
    entries: [], nextCursor: null, teamContact: null, submissionFocus: null,
  };
  function dashboardView(overrides: Partial<TeamReportingPanel> = {}) {
    const root = TeamReporting({ panel: { ...panel, ...overrides }, teamName: "Team", isLead: true,
      nowMs: Date.parse("2026-09-15T12:00:00Z"), variant: "dashboard" }) as Element;
    return new Hooks(root.type as Component, root.props).render();
  }
  const composerContainer = (view: Hooks) => elements(view.tree).find((element) => element.props.id === "update-project")!;

  it("hides the initial composer and keeps the same composer mounted when it is closed", () => {
    const view = dashboardView();
    const originalComposer = view.find("Composer");
    expect(composerContainer(view).props.hidden).toBe(true);
    view.event("button", "onClick", undefined, "Write update");
    expect(composerContainer(view).props.hidden).toBe(false);
    expect(view.find("button", "Hide update").props["aria-expanded"]).toBe(true);
    view.event("button", "onClick", undefined, "Hide update");
    expect(composerContainer(view).props.hidden).toBe(true);
    expect(view.find("Composer").type).toBe(originalComposer.type);
  });

  it("keeps an open draft accessible after reporting pauses or the final period closes", () => {
    const view = dashboardView();
    view.event("button", "onClick", undefined, "Write update");
    (view.find("Composer").props.onDraftChange as (value: boolean) => void)(true);
    view.render({ ...view.props, panel: { ...panel, paused: true, current: null } });
    expect(composerContainer(view).props.hidden).toBe(false);
    expect(view.find("Composer").props).toMatchObject({ period: null, paused: true });
    expect(view.find("button", "Hide update").props["aria-expanded"]).toBe(true);
    view.event("button", "onClick", undefined, "Hide update");
    view.event("button", "onClick", undefined, "Resume draft");
    expect(composerContainer(view).props.hidden).toBe(false);
  });

  it("collapses a successful update and returns focus to its trigger", () => {
    const view = dashboardView();
    view.event("button", "onClick", undefined, "Write update");
    const focus = vi.fn();
    (view.find("button", "Hide update").props.ref as { current: unknown }).current = { focus };
    (view.find("Composer").props.onSaved as () => void)();
    view.render();
    expect(composerContainer(view).props.hidden).toBe(true);
    expect(view.find("p", "Update saved.").props.role).toBe("status");
    expect(focus).toHaveBeenCalledOnce();
  });

  it("keeps historical entries and contact settings closed until requested", () => {
    const view = dashboardView();
    const node = view.find("ReportingDisclosure");
    const disclosure = new Hooks(node.type as Component, node.props).render();
    expect(disclosure.find("button").props["aria-expanded"]).toBe(false);
    expect(disclosure.find("div").props.hidden).toBe(true);
    disclosure.event("button", "onClick");
    expect(disclosure.find("div").props.hidden).toBe(false);
  });
});
