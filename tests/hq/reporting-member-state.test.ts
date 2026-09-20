// The team dossier's client state, driven through its real event handlers
// without a DOM: which week a save is bound to, what a late update carries,
// how a saved or edited entry replaces its older copy across a refresh, and
// what the two forms write. The Captains' Den has its own file.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportingEntryView } from "@/lib/hq/reporting";
import type { TeamPeriodView } from "@/lib/hq/reporting-surface";

type Element = ReactElement<Record<string, unknown>>;
type Component = (props: Record<string, unknown>) => ReactNode;
type Effect = { dependencies: readonly unknown[]; run: () => void | (() => void); cleanup?: () => void };

const mocks = vi.hoisted(() => ({
  hooks: null as Hooks | null,
  work: [] as Promise<unknown>[],
  refresh: vi.fn(), add: vi.fn(), edit: vi.fn(), load: vi.fn(), saveContact: vi.fn(), saveTeam: vi.fn(), invite: vi.fn(), setBot: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/hq/actions/reporting", () => ({
  addReportingUpdate: mocks.add, editReportingUpdate: mocks.edit, loadTeamUpdates: mocks.load, saveTeamContact: mocks.saveContact,
}));
vi.mock("@/lib/hq/actions/builders", () => ({ createBuilderInvite: mocks.invite, saveBuilderTeam: mocks.saveTeam }));
vi.mock("@/lib/hq/actions/telegram", () => ({ setBotMessaging: mocks.setBot }));
vi.mock("symbols-react", () => ({ IconArrowLeft: () => null }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => mocks.hooks!.state(initial),
  useRef: (initial: unknown) => mocks.hooks!.state(() => ({ current: initial }))[0],
  useCallback: (callback: unknown, dependencies: readonly unknown[]) => mocks.hooks!.memo(callback, dependencies),
  useEffect: (run: Effect["run"], dependencies: readonly unknown[]) => mocks.hooks!.effect(run, dependencies),
  useTransition: () => [false, (run: () => Promise<unknown>) => { mocks.work.push(run()); }],
}));

import { LateUpdateModal, latestStartedPeriod } from "@/components/hq/late-update-modal";
import { ReportingEntryCard } from "@/components/hq/reporting-entry-card";
import { TeamWorkspace, type TeamReportingProps, type TeamSnapshotProps, type TeamWorkspaceProps } from "@/components/hq/team-workspace";

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
  all(type: string): Element[] {
    return elements(this.tree).filter((element) => element.type === type || (typeof element.type === "function" && element.type.name === type));
  }
  find(type: string, label?: string): Element {
    const found = this.all(type).find((element) => label === undefined || element.props.children === label);
    if (!found) throw new Error(`Missing ${type} ${label ?? ""}`);
    return found;
  }
  has(type: string, label?: string): boolean {
    return this.all(type).some((element) => label === undefined || element.props.children === label);
  }
  event(type: string, event: string, value?: unknown, label?: string) {
    const handler = this.find(type, label).props[event] as (value: unknown) => void;
    handler(value);
    return this.render();
  }
  /** The child component of that name, rendered on its own with the props the parent handed it. */
  child(name: string) {
    const node = this.find(name);
    return new Hooks(node.type as Component, node.props).render();
  }
  cards() { return this.all("ReportingEntryCard").map((element) => element.props.entry as ReportingEntryView); }
}

const AMSTERDAM = "Europe/Amsterdam";
/** Thursday 17 September 2026, inside week one. */
const IN_WEEK_ONE = Date.parse("2026-09-17T12:00:00Z");
/** Thursday 1 October 2026, inside week three. */
const IN_WEEK_THREE = Date.parse("2026-10-01T12:00:00Z");

const DAY = 24 * 3600 * 1000;
/** Week n of a campaign starting Monday 14 September 2026, in Amsterdam summer time (local midnight is 22:00 UTC the evening before). */
const week = (sequence: number, completed = false): TeamPeriodView => {
  const monday = Date.UTC(2026, 8, 14 + (sequence - 1) * 7);
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    periodId: `week-${sequence}`, periodSequence: sequence, completed,
    startDate: date(monday), endDate: date(monday + 6 * DAY),
    startsAt: new Date(monday - 2 * 3600 * 1000).toISOString(), endsAt: new Date(monday + 7 * DAY - 2 * 3600 * 1000).toISOString(),
  };
};
/** When each fixture entry was written: newest first is the list's order, so the ids below read in that order too. */
const WRITTEN: Record<string, string> = { new: "2026-09-17T12:00:00Z", done: "2026-09-17T11:00:00Z", late: "2026-09-17T10:00:00Z", a: "2026-09-15T12:00:00Z", b: "2026-09-15T11:00:00Z", older: "2026-09-14T12:00:00Z" };
const entry = (id: string, version = 1, periodId = "week-1"): ReportingEntryView => ({
  id, version, periodId, periodSequence: Number(periodId.slice(5)), projectId: "project", body: `Body ${id} v${version}`, visibility: "shared", source: "hq",
  canEdit: true, authorIsYou: true, authorName: "Nienke Visser", submittedAt: WRITTEN[id], updatedAt: WRITTEN[id],
  late: false, edited: version > 1, voided: false,
});
const reporting = (overrides: Partial<TeamReportingProps> = {}): TeamReportingProps => ({
  projectId: "project", hackathonId: 1, timezone: AMSTERDAM, enrolled: true, paused: false, current: week(1),
  history: [week(1), week(2), week(3), week(4)], totalPeriods: 4, entries: [], nextCursor: null, teamContact: null, ...overrides,
});
const team: TeamSnapshotProps = {
  imageUrl: null, projectUrl: "https://colosseum.com/arena/projects/explore/grachtenpay", stage: "beta", category: "Payments", submissionStatus: "submitted",
  website: null, repoLink: null, leadUsername: "nienkev",
  roster: [{ name: "Nienke Visser", username: "nienkev", joined: true }, { name: "Tim Kuiper", username: "timk", joined: true }, { name: "Aisha Rahman", username: "aisha_r", joined: false }],
};
const props = (overrides: Partial<TeamWorkspaceProps> = {}): TeamWorkspaceProps => ({
  project: { name: "Grachtenpay", captain: null }, team, reporting: reporting(), canEditTeam: true, canInvite: true,
  nowMs: IN_WEEK_ONE, hasTelegram: true, botAllowed: true, botUrl: "https://t.me/fixture_bot", ...overrides,
});
const dossier = (overrides: Partial<TeamWorkspaceProps> = {}) => new Hooks(TeamWorkspace as unknown as Component, props(overrides)).render();
const change = (value: string) => ({ target: { value } });
const check = (checked: boolean) => ({ target: { checked } });
const submit = { preventDefault() {} };
const weekButtons = (view: Hooks) => view.all("button").filter((element) => "aria-pressed" in element.props);
const weekRange = (button: Element) => ((button.props.children as Element[])[1].props.children as string);
async function settle() { await Promise.all(mocks.work.splice(0)); await Promise.resolve(); await Promise.resolve(); }

beforeEach(() => {
  vi.clearAllMocks();
  mocks.work = [];
  mocks.add.mockResolvedValue({ ok: true, entry: entry("new"), completesPeriod: true });
  // The modal's effects reach the document for Escape and the scroll lock; the invite control reaches the window's origin and the clipboard.
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn(), body: { style: {} } });
  vi.stubGlobal("window", { location: { origin: "https://superteam.nl" } });
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("this week's update", () => {
  it("keeps a draft bound to its original week across a refresh until the author chooses the current week", async () => {
    mocks.add.mockResolvedValue({ ok: false, reason: "period_changed", error: "The week changed", currentPeriod: { id: "week-2" } });
    const composer = dossier().child("UpdateComposer");
    composer.event("textarea", "onChange", change("Week one progress"));
    composer.render({ ...composer.props, reporting: reporting({ current: week(2) }) });
    composer.event("textarea", "onChange", change("Week one progress, with detail"));
    composer.event("form", "onSubmit", submit); await settle(); composer.render();
    expect(mocks.add.mock.lastCall![0]).toMatchObject({ body: "Week one progress, with detail", expectedPeriodId: "week-1" });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    composer.event("button", "onClick", undefined, "Use current week");
    composer.event("form", "onSubmit", submit); await settle();
    expect(mocks.add.mock.lastCall![0]).toMatchObject({ body: "Week one progress, with detail", expectedPeriodId: "week-2" });
  });

  it("binds the save to the open week, then says it is saved and turns the week Updated", async () => {
    const view = dossier();
    expect(view.find("UpdateComposer").props.completed).toBe(false);
    const composer = view.child("UpdateComposer");
    expect(composer.find("button", "Add update").props.disabled).toBe(true);
    composer.event("textarea", "onChange", change("Shipped the QR checkout flow."));
    expect(composer.find("button", "Add update").props.disabled).toBe(false);
    composer.event("form", "onSubmit", submit); await settle(); composer.render();
    expect(mocks.add).toHaveBeenCalledWith({ projectId: "project", hackathonId: 1, body: "Shipped the QR checkout flow.", expectedPeriodId: "week-1" });
    expect(mocks.add.mock.lastCall![0]).not.toHaveProperty("periodId");
    expect(composer.find("textarea").props.value).toBe("");
    expect(composer.find("p", "Update saved.").props.role).toBe("status");
    expect(mocks.refresh).toHaveBeenCalledOnce();
    // The parent learnt of the entry and of the completed week without waiting for the refresh.
    view.render();
    expect(view.find("UpdateComposer").props.completed).toBe(true);
    expect(view.find("EarlierList").props.entries).toEqual([entry("new")]);
    // Typing again clears the status.
    composer.event("textarea", "onChange", change("More"));
    expect(composer.has("p", "Update saved.")).toBe(false);
  });

  it("keeps the text and shows the refusal when the week changed under the draft", async () => {
    mocks.add.mockResolvedValueOnce({ ok: false, reason: "period_changed", error: "The week changed", currentPeriod: null });
    const composer = dossier().child("UpdateComposer");
    composer.event("textarea", "onChange", change("My draft"));
    composer.event("form", "onSubmit", submit); await settle(); composer.render();
    expect(composer.find("textarea").props.value).toBe("My draft");
    expect(composer.find("p", "The week changed").props.role).toBe("alert");
    expect(composer.has("p", "Update saved.")).toBe(false);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("stays Not updated for a new week after an earlier one was completed here", () => {
    const view = dossier();
    (view.find("UpdateComposer").props.onSaved as (entry: ReportingEntryView, completes: boolean) => void)(entry("done"), true);
    view.render();
    expect(view.find("UpdateComposer").props.completed).toBe(true);
    view.render({ ...view.props, reporting: reporting({ current: week(2) }) });
    expect(view.find("UpdateComposer").props.completed).toBe(false);
  });

  it("offers nothing to add without an open week, while paused or before enrolment, keeping only the late link once a week has started", () => {
    const paused = dossier({ reporting: reporting({ paused: true }) }).child("UpdateComposer");
    expect(paused.tree).toBeNull();
    const unenrolled = dossier({ reporting: reporting({ enrolled: false, current: null, history: [] }) }).child("UpdateComposer");
    expect(unenrolled.tree).toBeNull();
    const afterCampaign = dossier({ reporting: reporting({ current: null }), nowMs: Date.parse("2026-10-20T12:00:00Z") }).child("UpdateComposer");
    expect(afterCampaign.has("button", "Add update")).toBe(false);
    expect(afterCampaign.has("h2")).toBe(false);
    expect(afterCampaign.has("button", "Missed a week's update?")).toBe(true);
    const beforeCampaign = dossier({ reporting: reporting({ current: null }), nowMs: Date.parse("2026-09-01T12:00:00Z") }).child("UpdateComposer");
    expect(beforeCampaign.tree).toBeNull();
  });
});

describe("a late update", () => {
  it("preselects the latest started week, disables the ones to come and marks the current one", () => {
    expect(latestStartedPeriod([week(1), week(2), week(3)], IN_WEEK_THREE)?.periodId).toBe("week-3");
    expect(latestStartedPeriod([week(1), week(2)], Date.parse("2026-09-01T12:00:00Z"))).toBeNull();
    const view = dossier({ nowMs: IN_WEEK_THREE, reporting: reporting({ current: week(3) }) });
    expect(view.has("LateUpdateModal")).toBe(false);
    view.child("UpdateComposer").event("button", "onClick", undefined, "Missed a week's update?");
    view.render();
    const modal = view.child("LateUpdateModal");
    const buttons = weekButtons(modal);
    expect(buttons.map((button) => button.props["aria-pressed"])).toEqual([false, false, true, false]);
    expect(buttons.map((button) => button.props.disabled)).toEqual([false, false, false, true]);
    expect(buttons.map(weekRange)).toEqual(["14 to 20 Sep", "21 to 27 Sep", "28 Sep to 4 Oct, current", "5 to 11 Oct"]);
    expect(modal.find("button", "Add late update").props.disabled).toBe(true);
  });

  it("sends the chosen week's id and never the week the box was opened against, then closes", async () => {
    mocks.add.mockResolvedValueOnce({ ok: true, entry: entry("late", 1, "week-1"), completesPeriod: false });
    const view = dossier({ nowMs: IN_WEEK_THREE, reporting: reporting({ current: week(3) }) });
    view.child("UpdateComposer").event("button", "onClick", undefined, "Missed a week's update?");
    view.render();
    const modal = view.child("LateUpdateModal");
    (weekButtons(modal)[0].props.onClick as () => void)();
    modal.render();
    expect(weekButtons(modal).map((button) => button.props["aria-pressed"])).toEqual([true, false, false, false]);
    modal.event("textarea", "onChange", change("What moved back then."));
    expect(modal.find("button", "Add late update").props.disabled).toBe(false);
    modal.event("form", "onSubmit", submit); await settle();
    expect(mocks.add).toHaveBeenCalledWith({ projectId: "project", hackathonId: 1, body: "What moved back then.", periodId: "week-1" });
    expect(mocks.add.mock.lastCall![0]).not.toHaveProperty("expectedPeriodId");
    expect(mocks.refresh).toHaveBeenCalledOnce();
    view.render();
    expect(view.has("LateUpdateModal")).toBe(false);
    expect(view.find("EarlierList").props.entries).toEqual([entry("late", 1, "week-1")]);
    // A late entry completes nothing.
    expect(view.find("UpdateComposer").props.completed).toBe(false);
  });

  it("keeps the draft and shows the refusal when the save fails, and closes on Cancel, the overlay or Escape", async () => {
    mocks.add.mockResolvedValueOnce({ ok: false, reason: "no_open_period", error: "No open week" });
    const onClose = vi.fn();
    const modal = new Hooks(LateUpdateModal as unknown as Component, { projectId: "project", hackathonId: 1, periods: [week(1), week(2)], nowMs: IN_WEEK_ONE, onClose, onSaved: vi.fn() }).render();
    modal.event("textarea", "onChange", change("Kept"));
    modal.event("form", "onSubmit", submit); await settle(); modal.render();
    expect(modal.find("textarea").props.value).toBe("Kept");
    expect(modal.find("p", "No open week").props.role).toBe("alert");
    expect(onClose).not.toHaveBeenCalled();
    modal.event("button", "onClick", undefined, "Cancel");
    expect(onClose).toHaveBeenCalledTimes(1);
    (modal.find("div").props.onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(2);
    const listeners = (document.addEventListener as ReturnType<typeof vi.fn>).mock.calls.filter(([type]) => type === "keydown").map(([, listener]) => listener as (event: { key: string }) => void);
    listeners.forEach(listener => listener({ key: "Enter" }));
    listeners.forEach(listener => listener({ key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(modal.find("div").props.role).toBeUndefined();
    expect(modal.all("div")[1].props).toMatchObject({ role: "dialog", "aria-modal": "true", "aria-labelledby": "late-title" });
  });
});

describe("the Earlier list", () => {
  it("shows a saved edit at once and never reverts to the copy a refresh brings back", () => {
    const view = dossier({ reporting: reporting({ entries: [entry("a"), entry("b")] }) });
    const earlier = view.child("EarlierList");
    expect(earlier.cards().map((card) => card.id)).toEqual(["a", "b"]);
    (earlier.find("ReportingEntryCard").props.onSaved as (entry: ReportingEntryView) => void)(entry("a", 2));
    view.render();
    expect((view.find("EarlierList").props.entries as ReportingEntryView[]).find((item) => item.id === "a")?.version).toBe(2);
    expect(view.find("UpdateComposer").props.completed).toBe(false);
    view.render({ ...view.props, reporting: reporting({ entries: [entry("a", 1), entry("b")] }) });
    expect((view.find("EarlierList").props.entries as ReportingEntryView[]).find((item) => item.id === "a")?.version).toBe(2);
    view.render({ ...view.props, reporting: reporting({ entries: [entry("a", 3), entry("b")] }) });
    expect((view.find("EarlierList").props.entries as ReportingEntryView[]).find((item) => item.id === "a")?.version).toBe(3);
  });

  it("loads older updates behind the cursor and merges them below, then offers no more", async () => {
    mocks.load.mockResolvedValue({ entries: [entry("older")], nextCursor: null });
    const earlier = dossier({ reporting: reporting({ entries: [entry("a"), entry("b")], nextCursor: "older" }) }).child("EarlierList");
    expect(earlier.cards()).toHaveLength(2);
    earlier.event("button", "onClick", undefined, "Show older updates"); await settle(); earlier.render();
    expect(mocks.load).toHaveBeenCalledWith({ projectId: "project", hackathonId: 1, cursor: "older" });
    expect(earlier.cards().map((card) => card.id)).toEqual(["a", "b", "older"]);
    expect(earlier.has("button", "Show older updates")).toBe(false);
    // The loaded page's cursor is the one that counts now, whatever a refresh says the first page's is.
    earlier.render({ ...earlier.props, reporting: reporting({ entries: [entry("a"), entry("b")], nextCursor: "older" }) });
    expect(earlier.has("button", "Show older updates")).toBe(false);
    expect(dossier().child("EarlierList").has("button", "Show older updates")).toBe(false);
  });

  it("follows the server's cursor until an older page has been loaded, so a first page that grew after a refresh still offers the rest", () => {
    const earlier = dossier({ reporting: reporting({ entries: [entry("a")] }) }).child("EarlierList");
    expect(earlier.has("button", "Show older updates")).toBe(false);
    earlier.render({ ...earlier.props, reporting: reporting({ entries: [entry("new"), entry("a")], nextCursor: "after-a" }) });
    expect(earlier.has("button", "Show older updates")).toBe(true);
  });

  it("words each card's meta line for the team page and offers Edit only to the author", () => {
    const earlier = dossier({ reporting: reporting({ entries: [entry("a"), { ...entry("b", 2, "week-1"), canEdit: false, late: true }] }) }).child("EarlierList");
    expect(earlier.all("ReportingEntryCard").map((card) => [card.props.meta, card.props.canEdit])).toEqual([
      ["Week 1. Nienke Visser, 15 September", true],
      ["Week 1. Nienke Visser, added late, edited", false],
    ]);
  });

  it("keeps an edit's opening version and its draft when the save conflicts", async () => {
    const card = new Hooks(ReportingEntryCard as unknown as Component, { entry: entry("a"), meta: "Week 1. Nienke Visser, 15 September", canEdit: true, onSaved: vi.fn() }).render();
    card.event("button", "onClick", undefined, "Edit");
    card.event("textarea", "onChange", change("My edit"));
    card.render({ ...card.props, entry: entry("a", 2) });
    mocks.edit.mockResolvedValue({ ok: false, reason: "conflict", error: "Changed elsewhere", current: entry("a", 2) });
    card.event("form", "onSubmit", submit); await settle(); card.render();
    expect(mocks.edit).toHaveBeenCalledWith(expect.objectContaining({ entryId: "a", expectedVersion: 1, body: "My edit" }));
    expect(card.find("textarea").props.value).toBe("My edit");
    expect(card.find("p", "Changed elsewhere").props.role).toBe("alert");
  });
});

describe("the two forms", () => {
  it("switches the main column to Team settings and back, keeping the update column mounted", () => {
    const view = dossier();
    const hidden = () => view.all("div").find((element) => "hidden" in element.props)!.props.hidden;
    expect(hidden()).toBe(false);
    expect(view.has("SettingsView")).toBe(false);
    view.event("button", "onClick", undefined, "Team settings");
    expect(hidden()).toBe(true);
    expect(view.has("SettingsView")).toBe(true);
    expect(view.has("UpdateComposer")).toBe(true);
    expect(view.find("button", "Team settings").props["aria-current"]).toBe("true");
    expect(view.find("button", "Contact preference").props["aria-current"]).toBeUndefined();
    (view.child("SettingsView").find("BackButton").props.onClick as () => void)();
    view.render();
    expect(hidden()).toBe(false);
    expect(view.has("SettingsView")).toBe(false);
    view.event("button", "onClick", undefined, "Contact preference");
    expect(view.has("ContactView")).toBe(true);
    // A teammate has no Team settings; a project without a snapshot has none either.
    expect(dossier({ canEditTeam: false }).has("button", "Team settings")).toBe(false);
    expect(dossier({ team: null }).has("button", "Team settings")).toBe(false);
    expect(dossier({ team: null }).has("button", "Contact preference")).toBe(true);
  });

  it("saves the stage and the lead through the team action and says Saved. until the next change", async () => {
    mocks.saveTeam.mockResolvedValue({ ok: true, data: { saved: true } });
    const settings = dossier().event("button", "onClick", undefined, "Team settings").child("SettingsView");
    const [stage, lead] = settings.all("select");
    expect(stage.props.value).toBe("beta");
    expect(lead.props.value).toBe("nienkev");
    expect((lead.props.children as Element[]).map((option) => option.props.value)).toEqual(["nienkev", "timk", "aisha_r"]);
    (stage.props.onChange as (event: unknown) => void)(change("live"));
    settings.render();
    (settings.all("select")[1].props.onChange as (event: unknown) => void)(change("timk"));
    settings.render();
    settings.event("form", "onSubmit", submit); await settle(); settings.render();
    expect(mocks.saveTeam).toHaveBeenCalledWith({ projectId: "project", hackathonId: 1, stage: "live", leadUsername: "timk" });
    expect(settings.find("span", "Saved.").props.role).toBe("status");
    expect(mocks.refresh).toHaveBeenCalledOnce();
    (settings.all("select")[0].props.onChange as (event: unknown) => void)(change("idea"));
    settings.render();
    expect(settings.has("span", "Saved.")).toBe(false);
    mocks.saveTeam.mockResolvedValueOnce({ ok: false, error: "Choose a lead from your imported team." });
    settings.event("form", "onSubmit", submit); await settle(); settings.render();
    expect(settings.find("p", "Choose a lead from your imported team.").props.role).toBe("alert");
    expect(settings.has("span", "Saved.")).toBe(false);
  });

  it("saves the team contact and the bot consent behind one Save for the lead", async () => {
    mocks.saveContact.mockResolvedValue({ ok: true, contact: "@nienkev" });
    mocks.setBot.mockResolvedValue({ ok: true, enabled: false });
    const contact = dossier({ reporting: reporting({ teamContact: "@old" }) }).event("button", "onClick", undefined, "Contact preference").child("ContactView");
    expect(contact.find("input").props.value).toBe("@old");
    const checkbox = () => contact.all("input").find((element) => element.props.type === "checkbox")!;
    expect(checkbox().props).toMatchObject({ checked: true, disabled: false });
    contact.event("input", "onChange", change("@nienkev"));
    (checkbox().props.onChange as (event: unknown) => void)(check(false));
    contact.render();
    contact.event("form", "onSubmit", submit); await settle(); contact.render();
    expect(mocks.saveContact).toHaveBeenCalledWith({ projectId: "project", hackathonId: 1, contact: "@nienkev" });
    expect(mocks.setBot).toHaveBeenCalledWith(false);
    expect(contact.find("span", "Saved.").props.role).toBe("status");
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("writes only the consent for a teammate, and nothing for the bot without Telegram", async () => {
    mocks.setBot.mockResolvedValue({ ok: true, enabled: true });
    const mate = dossier({ canEditTeam: false }).event("button", "onClick", undefined, "Contact preference").child("ContactView");
    expect(mate.all("input").map((element) => element.props.type)).toEqual(["checkbox"]);
    expect(mate.has("span", "Shared with your Captain and Superteam NL.")).toBe(false);
    mate.event("form", "onSubmit", submit); await settle(); mate.render();
    expect(mocks.saveContact).not.toHaveBeenCalled();
    expect(mocks.setBot).toHaveBeenCalledWith(true);
    expect(mate.has("span", "Saved.")).toBe(true);

    vi.clearAllMocks();
    const offline = dossier({ hasTelegram: false, botAllowed: false }).event("button", "onClick", undefined, "Contact preference").child("ContactView");
    const checkbox = offline.all("input").find((element) => element.props.type === "checkbox")!;
    expect(checkbox.props).toMatchObject({ checked: false, disabled: true });
    expect(String(offline.all("label").at(-1)!.props.className)).toContain("checkDisabled");
    offline.event("form", "onSubmit", submit); await settle(); offline.render();
    expect(mocks.setBot).not.toHaveBeenCalled();
  });

  it("keeps the drafts and shows the refusal when a contact write fails, writing nothing further", async () => {
    mocks.saveContact.mockResolvedValue({ ok: false, error: "This team is not available to your account." });
    const contact = dossier().event("button", "onClick", undefined, "Contact preference").child("ContactView");
    contact.event("input", "onChange", change("@kept"));
    contact.event("form", "onSubmit", submit); await settle(); contact.render();
    expect(contact.find("input").props.value).toBe("@kept");
    expect(contact.find("p", "This team is not available to your account.").props.role).toBe("alert");
    expect(mocks.setBot).not.toHaveBeenCalled();
    expect(contact.has("span", "Saved.")).toBe(false);
  });
});

describe("the join link", () => {
  it("is created on the first open, shown once it arrives, copied with one press, and never created twice", async () => {
    mocks.invite.mockResolvedValue({ ok: true, data: { code: "ABCDEF-123456-ABCDEF-123456" } });
    const invite = dossier().child("InviteControl");
    expect(invite.find("button", "Invite teammates").props["aria-expanded"]).toBe(false);
    expect(invite.has("input")).toBe(false);
    invite.event("button", "onClick", undefined, "Invite teammates"); await settle(); invite.render();
    expect(mocks.invite).toHaveBeenCalledWith({ projectId: "project", hackathonId: 1 });
    expect(invite.find("button", "Hide join link").props["aria-expanded"]).toBe(true);
    expect(invite.find("input").props).toMatchObject({ value: "https://superteam.nl/hq/join/ABCDEF-123456-ABCDEF-123456", readOnly: true, "aria-label": "Team join link" });
    invite.event("button", "onClick", undefined, "Copy link"); await settle(); invite.render();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://superteam.nl/hq/join/ABCDEF-123456-ABCDEF-123456");
    expect(invite.has("button", "Copied")).toBe(true);
    invite.event("button", "onClick", undefined, "Hide join link");
    expect(invite.has("input")).toBe(false);
    invite.event("button", "onClick", undefined, "Invite teammates"); await settle(); invite.render();
    expect(mocks.invite).toHaveBeenCalledOnce();
    expect(invite.has("input")).toBe(true);
  });

  it.each(["unavailable", "denied"])("keeps the join link available for manual copying when clipboard access is %s", async (failure) => {
    mocks.invite.mockResolvedValue({ ok: true, data: { code: "ABCDEF-123456-ABCDEF-123456" } });
    const invite = dossier().child("InviteControl");
    invite.event("button", "onClick", undefined, "Invite teammates"); await settle(); invite.render();
    vi.stubGlobal("navigator", failure === "unavailable" ? {} : { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) } });
    invite.event("button", "onClick", undefined, "Copy link"); await settle(); invite.render();
    expect(invite.has("button", "Copied")).toBe(false);
    expect(invite.find("p", "Could not copy. Select the link and copy it manually.").props.role).toBe("alert");
    expect(invite.find("input").props.readOnly).toBe(true);
  });

  it("shows the refusal in place of the link", async () => {
    mocks.invite.mockResolvedValue({ ok: false, error: "This team is not available to your account." });
    const invite = dossier().child("InviteControl");
    invite.event("button", "onClick", undefined, "Invite teammates"); await settle(); invite.render();
    expect(invite.has("input")).toBe(false);
    expect(invite.find("p", "This team is not available to your account.").props.role).toBe("alert");
    expect(dossier({ canInvite: false }).has("InviteControl")).toBe(false);
  });
});
