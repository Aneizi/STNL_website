// The Captains' Den's client state, exercised through the real event handlers
// with React's hook storage replaced (the pattern of reporting-member-state):
// which team is selected, the draft each team keeps, what a save sends and
// shows, and what it never does, which is change the team's status.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
// This harness traverses native controls, not nested function components.
vi.mock("@/components/hq/update-textarea", () => ({ UpdateTextarea: "textarea" }));
import type { ReportingEntryView } from "@/lib/hq/reporting";

type Element = ReactElement<Record<string, unknown>>;

const mocks = vi.hoisted(() => ({
  hooks: null as Hooks | null,
  work: [] as Promise<unknown>[],
  refresh: vi.fn(), add: vi.fn(), load: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("symbols-react", () => ({ IconArrowLeft: () => null }));
vi.mock("@/lib/hq/actions/reporting", () => ({ addReportingUpdate: mocks.add, loadTeamUpdates: mocks.load, editReportingUpdate: vi.fn(), loadMemberColosseumUpdates: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => mocks.hooks!.state(initial),
  useTransition: () => [false, (run: () => Promise<unknown>) => { mocks.work.push(run()); }],
}));

import { BuilderCaptainDen, type BuilderCaptainDenProps, type CaptainDenTeam } from "@/components/hq/builder-captain-den";

function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

/** The string content of an element tree, for finding a control by what it says. */
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return "";
}

/** Runs the component's real handlers across renders without a DOM: only React's hook storage is replaced. */
class Hooks {
  slots: unknown[] = [];
  position = 0;
  dirty = false;
  tree: ReactNode = null;
  constructor(public props: BuilderCaptainDenProps) {}
  state(initial: unknown): [unknown, (next: unknown) => void] {
    const index = this.position++;
    if (!(index in this.slots)) this.slots[index] = typeof initial === "function" ? initial() : initial;
    return [this.slots[index], (next) => {
      const value = typeof next === "function" ? next(this.slots[index]) : next;
      if (!Object.is(this.slots[index], value)) { this.slots[index] = value; this.dirty = true; }
    }];
  }
  render(props = this.props) {
    this.props = props;
    mocks.hooks = this;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      this.position = 0; this.dirty = false;
      this.tree = BuilderCaptainDen(props);
      if (!this.dirty) break;
    }
    return this;
  }
  all(where: (element: Element) => boolean): Element[] { return elements(this.tree).filter(where); }
  find(where: (element: Element) => boolean): Element {
    const found = this.all(where);
    if (!found.length) throw new Error("Missing element");
    return found[0];
  }
  has(where: (element: Element) => boolean): boolean { return this.all(where).length > 0; }
  /** A tag with exactly this text, such as the Add note button or the status kicker. */
  byText(type: string, label: string): Element { return this.find((element) => element.type === type && text(element) === label); }
  teamButton(name: string): Element { return this.find((element) => element.type === "button" && "aria-pressed" in element.props && text(element).startsWith(name)); }
  fire(element: Element, event: string, value?: unknown) {
    (element.props[event] as (value: unknown) => void)(value);
    return this.render();
  }
  textarea(): Element | null { return this.all((element) => element.type === "textarea")[0] ?? null; }
  status(): string { return text(this.find((element) => element.type === "p" && /Team |No open week|Reporting paused/.test(text(element)))); }
  cards(): ReportingEntryView[] {
    return this.all((element) => typeof element.type === "function" && element.type.name === "ReportingEntryCard").map((element) => element.props.entry as ReportingEntryView);
  }
  cardProps(id: string): Record<string, unknown> {
    return this.find((element) => typeof element.type === "function" && element.type.name === "ReportingEntryCard" && (element.props.entry as ReportingEntryView).id === id).props;
  }
}

const AMSTERDAM = "Europe/Amsterdam";
const WEEK_ONE = { periodId: "week-1", endsAt: "2026-09-20T22:00:00.000Z", completed: false };

const entry = (id: string, overrides: Partial<ReportingEntryView> = {}): ReportingEntryView => ({
  id, version: 1, periodId: "week-1", periodSequence: 1, projectId: "windmolen", body: `Body ${id}`, visibility: "shared", source: "hq",
  canEdit: false, authorIsYou: false, authorName: "Nienke Visser", submittedAt: "2026-09-16T10:00:00.000Z", updatedAt: "2026-09-16T10:00:00.000Z",
  late: false, edited: false, voided: false, ...overrides,
});

const team = (projectId: string, name: string, overrides: Partial<CaptainDenTeam> = {}): CaptainDenTeam => ({
  projectId, hackathonId: 41, name, paused: false, current: WEEK_ONE,
  roster: [{ name: "Bram Hendriks", username: "bramh", joined: true }, { name: "Sofie Jansen", username: "sofiej", joined: false }],
  leadUsername: "bramh", projectUrl: `https://colosseum.com/arena/projects/${projectId}`, teamContact: null, entries: [], nextCursor: null, ...overrides,
});

const den = (teams: CaptainDenTeam[] = [team("windmolen", "Windmolen DAO"), team("grachtenpay", "Grachtenpay")], overrides: Partial<BuilderCaptainDenProps> = {}) =>
  new Hooks({ teams, week: { sequence: 1, total: 4 }, timezone: AMSTERDAM, contact: "@femkedj", ...overrides }).render();

const typed = (value: string) => ({ target: { value } });
const checked = (value: boolean) => ({ target: { checked: value } });
const submit = { preventDefault() {} };
async function settle() {
  await Promise.all(mocks.work.splice(0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.work = [];
  mocks.add.mockResolvedValue({ ok: true, entry: entry("new", { authorIsYou: true, authorName: "Femke de Jong", visibility: "sensitive", submittedAt: "2026-09-18T10:00:00.000Z" }), completesPeriod: false });
});

describe("selecting a team", () => {
  it("selects the first team, and switching keeps each team's draft, private choice and status", () => {
    const view = den();
    expect(view.teamButton("Windmolen DAO").props["aria-pressed"]).toBe(true);
    expect(view.teamButton("Grachtenpay").props["aria-pressed"]).toBe(false);
    expect(text(view.find((element) => element.type === "h2"))).toBe("Windmolen DAO");
    expect(view.byText("button", "Add note").props.disabled).toBe(true);

    view.fire(view.textarea()!, "onChange", typed("Nudged Sofie about joining."));
    view.fire(view.find((element) => element.type === "input"), "onChange", checked(true));
    expect(view.byText("button", "Add note").props.disabled).toBe(false);

    view.fire(view.teamButton("Grachtenpay"), "onClick");
    expect(view.teamButton("Grachtenpay").props["aria-pressed"]).toBe(true);
    expect(text(view.find((element) => element.type === "h2"))).toBe("Grachtenpay");
    expect(view.textarea()!.props.value).toBe("");
    expect(view.find((element) => element.type === "input").props.checked).toBe(false);
    expect(view.byText("button", "Add note").props.disabled).toBe(true);

    view.fire(view.teamButton("Windmolen DAO"), "onClick");
    expect(view.textarea()!.props.value).toBe("Nudged Sofie about joining.");
    expect(view.find((element) => element.type === "input").props.checked).toBe(true);
  });

  it("explains how to get teams assigned, and still shows the aside", () => {
    const view = den([]);
    expect(view.has((element) => element.type === "p" && text(element) === "No teams assigned yet. Reach out to an admin to link your teams to you.")).toBe(true);
    expect(view.textarea()).toBeNull();
    expect(view.has((element) => element.type === "p" && text(element) === "Your teams")).toBe(true);
    expect(view.has((element) => element.type === "p" && text(element) === "@femkedj")).toBe(true);
  });
});

describe("the status and the marker", () => {
  it("reads the due line while the week is open, and Updated with the note optional once the team wrote", () => {
    const open = den();
    expect(open.status()).toBe("Team not updated. Due Sunday 20 September, 23:59 CEST");
    expect(open.has((element) => element.props["aria-label"] === "Not updated")).toBe(true);
    expect(open.has((element) => element.type === "p" && text(element) === "Your note")).toBe(true);

    const done = den([team("grachtenpay", "Grachtenpay", { current: { ...WEEK_ONE, completed: true } })]);
    expect(done.status()).toBe("Team updated this week. No note needed");
    expect(text(done.teamButton("Grachtenpay"))).toBe("GrachtenpayUpdated");
    expect(done.has((element) => element.props["aria-label"] === "Not updated")).toBe(false);
    expect(done.has((element) => element.type === "p" && text(element) === "Your note (optional)")).toBe(true);
    expect(done.textarea()).not.toBeNull();
  });

  it("hides the note form and shows no marker outside an open week or while reporting is paused", () => {
    const closed = den([team("windmolen", "Windmolen DAO", { current: null })]);
    expect(closed.status()).toBe("No open week");
    expect(closed.textarea()).toBeNull();
    expect(text(closed.teamButton("Windmolen DAO"))).toBe("Windmolen DAO");
    expect(closed.has((element) => element.props["aria-label"] === "Not updated")).toBe(false);

    const paused = den([team("windmolen", "Windmolen DAO", { paused: true })]);
    expect(paused.status()).toBe("Reporting paused");
    expect(paused.textarea()).toBeNull();
    expect(text(paused.teamButton("Windmolen DAO"))).toBe("Windmolen DAO");
  });
});

describe("adding a note", () => {
  it("keeps each team's draft week across a refresh until the Captain chooses the current week", async () => {
    mocks.add.mockResolvedValue({ ok: false, reason: "period_changed", error: "The week changed", currentPeriod: { id: "week-2" } });
    const view = den();
    view.fire(view.textarea()!, "onChange", typed("Week one note"));
    view.fire(view.teamButton("Grachtenpay"), "onClick");
    view.render({ ...view.props, teams: view.props.teams.map((item) => ({ ...item, current: { ...WEEK_ONE, periodId: "week-2" } })) });
    view.fire(view.teamButton("Windmolen DAO"), "onClick");
    view.fire(view.textarea()!, "onChange", typed("Week one note, with detail"));
    view.fire(view.find((element) => element.type === "form"), "onSubmit", submit); await settle(); view.render();
    expect(mocks.add.mock.lastCall![0]).toMatchObject({ projectId: "windmolen", body: "Week one note, with detail", expectedPeriodId: "week-1" });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    view.fire(view.byText("button", "Use current week"), "onClick");
    view.fire(view.find((element) => element.type === "form"), "onSubmit", submit); await settle();
    expect(mocks.add.mock.lastCall![0]).toMatchObject({ projectId: "windmolen", body: "Week one note, with detail", expectedPeriodId: "week-2" });
  });

  it("sends a private note against the open week, shows it and Note added, clears the draft, and never flips the status", async () => {
    const view = den();
    view.fire(view.textarea()!, "onChange", typed("Team dynamics look healthy."));
    view.fire(view.find((element) => element.type === "input"), "onChange", checked(true));
    view.fire(view.find((element) => element.type === "form"), "onSubmit", submit);
    await settle();
    view.render();

    expect(mocks.add).toHaveBeenCalledWith({ projectId: "windmolen", hackathonId: 41, body: "Team dynamics look healthy.", visibility: "sensitive", expectedPeriodId: "week-1" });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(view.textarea()!.props.value).toBe("");
    expect(view.byText("button", "Add note").props.disabled).toBe(true);
    expect(view.has((element) => element.props.role === "status" && text(element) === "Note added.")).toBe(true);
    // The private choice is not reset by a save.
    expect(view.find((element) => element.type === "input").props.checked).toBe(true);
    // The note is shown at once, read only, with the private tag and the Den's own meta line.
    expect(view.cards().map((card) => card.id)).toEqual(["new"]);
    const card = view.cardProps("new");
    expect(card.canEdit).toBe(false);
    expect(card.meta).toBe("You, 18 September");
    expect(card.tag).toBeTruthy();
    // A note is not the team's update: the status and the marker say what the server said.
    expect(view.status()).toBe("Team not updated. Due Sunday 20 September, 23:59 CEST");
    expect(view.has((element) => element.props["aria-label"] === "Not updated")).toBe(true);
    // Typing again clears the confirmation.
    view.fire(view.textarea()!, "onChange", typed("More"));
    expect(view.has((element) => element.props.role === "status")).toBe(false);
  });

  it("sends a shared note with no tag when Keep private is off", async () => {
    mocks.add.mockResolvedValue({ ok: true, entry: entry("shared", { authorIsYou: true, authorName: "Femke de Jong" }), completesPeriod: false });
    const view = den();
    view.fire(view.textarea()!, "onChange", typed("Told them to demo on Friday."));
    view.fire(view.find((element) => element.type === "form"), "onSubmit", submit);
    await settle();
    view.render();
    expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ visibility: "shared" }));
    expect(view.cardProps("shared").tag).toBeUndefined();
  });

  it("refuses to send a blank note", async () => {
    const view = den();
    view.fire(view.textarea()!, "onChange", typed("   "));
    view.fire(view.find((element) => element.type === "form"), "onSubmit", submit);
    await settle();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("keeps the draft and shows the refusal or the failure in the button row", async () => {
    mocks.add.mockResolvedValue({ ok: false, reason: "period_changed", error: "The week changed while you were writing.", currentPeriod: null });
    const view = den();
    view.fire(view.textarea()!, "onChange", typed("Kept."));
    view.fire(view.find((element) => element.type === "form"), "onSubmit", submit);
    await settle();
    view.render();
    expect(view.textarea()!.props.value).toBe("Kept.");
    expect(text(view.find((element) => element.props.role === "alert"))).toBe("The week changed while you were writing.");
    expect(view.has((element) => element.props.role === "status")).toBe(false);
    expect(mocks.refresh).not.toHaveBeenCalled();

    mocks.add.mockRejectedValue(new Error("offline"));
    view.fire(view.find((element) => element.type === "form"), "onSubmit", submit);
    await settle();
    view.render();
    expect(view.textarea()!.props.value).toBe("Kept.");
    expect(text(view.find((element) => element.props.role === "alert"))).toBe("The note could not be saved. Your text is kept. Try again.");
  });

  it("does not double a saved note once the refreshed page carries it", async () => {
    const view = den();
    view.fire(view.textarea()!, "onChange", typed("Once."));
    view.fire(view.find((element) => element.type === "form"), "onSubmit", submit);
    await settle();
    view.render();
    expect(view.cards()).toHaveLength(1);
    const saved = mocks.add.mock.results[0].value as Promise<{ entry: ReportingEntryView }>;
    const refreshed = [team("windmolen", "Windmolen DAO", { entries: [(await saved).entry, entry("older")] }), team("grachtenpay", "Grachtenpay")];
    view.render({ ...view.props, teams: refreshed });
    expect(view.cards().map((card) => card.id)).toEqual(["new", "older"]);
  });
});

describe("the private tooltip", () => {
  it("is always in the markup for the checkbox's description, and shown on hover and on focus", () => {
    const view = den();
    const tip = () => view.find((element) => element.props.role === "tooltip");
    expect(tip().props.id).toBe("priv-tip");
    expect(view.find((element) => element.type === "input").props["aria-describedby"]).toBe("priv-tip");
    expect(text(tip())).toBe("Only visible to you and HQ admins");
    expect(tip().props.hidden).toBe(true);
    const wrap = () => view.find((element) => "onMouseEnter" in element.props);
    view.fire(wrap(), "onMouseEnter");
    expect(tip().props.hidden).toBe(false);
    view.fire(wrap(), "onMouseLeave");
    expect(tip().props.hidden).toBe(true);
    view.fire(wrap(), "onFocus");
    expect(tip().props.hidden).toBe(false);
    view.fire(wrap(), "onBlur");
    expect(tip().props.hidden).toBe(true);
  });
});

describe("the contact and the last update", () => {
  it("links a team contact only when it is shaped like a Telegram handle, and says so when there is none", () => {
    const link = (view: Hooks) => view.all((element) => element.type === "a" && text(element) !== "View on Colosseum" && !("href" in element.props && String(element.props.href).startsWith("/hq")));
    const handle = den([team("windmolen", "Windmolen DAO", { teamContact: "@nienkev" })]);
    expect(link(handle)).toHaveLength(1);
    expect(link(handle)[0].props.href).toBe("https://t.me/nienkev");
    expect(link(handle)[0].props.rel).toBe("noopener noreferrer");
    const typedText = den([team("windmolen", "Windmolen DAO", { teamContact: "mail nienke at example dot test" })]);
    expect(link(typedText)).toHaveLength(0);
    expect(typedText.has((element) => element.type === "p" && text(element) === "mail nienke at example dot test")).toBe(true);
    const none = den([team("windmolen", "Windmolen DAO")]);
    expect(none.has((element) => element.type === "p" && text(element) === "Not shared yet.")).toBe(true);
  });

  it("omits the Colosseum link and lists no builders for a project that was never imported", () => {
    const view = den([team("side", "Side CRM Project", { projectUrl: null, roster: [], leadUsername: null })]);
    expect(view.has((element) => element.type === "a" && text(element) === "View on Colosseum")).toBe(false);
    expect(view.has((element) => element.type === "li")).toBe(false);
    expect(view.has((element) => element.type === "p" && text(element) === "Builders")).toBe(true);
  });

  it("names the team's newest shared entry as the last update, never the Captain's own note", () => {
    const own = entry("own", { authorIsYou: true, authorName: "Femke de Jong", submittedAt: "2026-09-17T10:00:00.000Z" });
    const secret = entry("secret", { authorIsYou: true, visibility: "sensitive", submittedAt: "2026-09-17T09:00:00.000Z" });
    const theirs = entry("theirs", { submittedAt: "2026-09-16T10:00:00.000Z" });
    const view = den([team("windmolen", "Windmolen DAO", { entries: [own, secret, theirs] })]);
    expect(view.has((element) => element.type === "p" && text(element) === "Last update: Nienke Visser, 16 September.")).toBe(true);
    expect(view.cards().map((card) => card.id)).toEqual(["own", "secret", "theirs"]);
    const quiet = den([team("windmolen", "Windmolen DAO", { entries: [own, secret] })]);
    expect(quiet.has((element) => element.type === "p" && text(element) === "No update from the team this week.")).toBe(true);
  });
});

describe("older notes", () => {
  it("loads the next page behind the cursor into the list, then drops the control at the end", async () => {
    mocks.load.mockResolvedValue({ entries: [entry("c", { submittedAt: "2026-09-10T10:00:00.000Z" })], nextCursor: null });
    const view = den([team("windmolen", "Windmolen DAO", { entries: [entry("a"), entry("b", { submittedAt: "2026-09-15T10:00:00.000Z" })], nextCursor: "older" })]);
    view.fire(view.byText("button", "Show older notes"), "onClick");
    expect(view.byText("button", "Show older notes").props.disabled).toBe(true);
    await settle();
    view.render();
    expect(mocks.load).toHaveBeenCalledWith({ projectId: "windmolen", hackathonId: 41, cursor: "older" });
    expect(view.cards().map((card) => card.id)).toEqual(["a", "b", "c"]);
    expect(view.has((element) => element.type === "button" && text(element) === "Show older notes")).toBe(false);
  });

  it("says when the older page could not load, and offers the control again", async () => {
    mocks.load.mockRejectedValue(new Error("offline"));
    const view = den([team("windmolen", "Windmolen DAO", { entries: [entry("a")], nextCursor: "older" })]);
    view.fire(view.byText("button", "Show older notes"), "onClick");
    await settle();
    view.render();
    expect(text(view.find((element) => element.props.role === "alert"))).toBe("Older notes could not be loaded. Try again.");
    expect(view.byText("button", "Show older notes").props.disabled).toBe(false);
    expect(view.cards()).toHaveLength(1);
  });
});
