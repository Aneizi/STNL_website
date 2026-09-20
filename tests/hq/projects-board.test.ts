// The operator Projects board, rendered to static markup: the header and
// filter bar, the table with its eight columns and the fixed HP slot, the
// Weekly column's states, and the expanded row's four blocks (Colosseum,
// Submission gates, Details, Timeline) for an imported project and for one
// created in HQ. Nothing here reaches a database: the actions are mocked by
// name, and a deep link (`expandId`) opens the row in the first render.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PeriodStatus, ProjectReportingStatus } from "@/lib/hq/reporting";
import type { Classifiers, Project, Settings } from "@/lib/hq/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {}, push() {} }) }));
vi.mock("@/components/hq/toast", () => ({ showToast: vi.fn() }));
vi.mock("@/lib/hq/actions/reporting-admin", () => ({ loadProjectReportingUpdates: vi.fn(), loadProjectColosseumUpdates: vi.fn() }));
vi.mock("@/lib/hq/actions/projects", () => ({
  addProjectMember: vi.fn(), addProjectNote: vi.fn(), createProject: vi.fn(), deleteProject: vi.fn(), editProjectNote: vi.fn(),
  removeProjectMember: vi.fn(), saveProjectBlocker: vi.fn(), setProjectForecast: vi.fn(),
  setProjectHighPotential: vi.fn(), toggleProjectGate: vi.fn(), updateProjectDetail: vi.fn(),
  updateProjectMember: vi.fn(),
}));
vi.mock("@/lib/hq/actions/captains", () => ({
  assignProjectCaptain: vi.fn(), unassignProjectCaptain: vi.fn(), createCaptainInvitation: vi.fn(), revokeCaptainInvitation: vi.fn(),
}));
vi.mock("@/lib/hq/actions/builders-admin", () => ({
  updateBuilderProjectLead: vi.fn(), attachColosseumProject: vi.fn(), createProjectFromImportRequest: vi.fn(),
  resolveBuilderImportRequest: vi.fn(), updateBuilderOnboardingConfig: vi.fn(),
}));
vi.mock("@/lib/hq/actions/capabilities", () => ({ grantCaptainCapability: vi.fn(), revokeCaptainCapability: vi.fn() }));

import { Projects } from "@/components/hq/projects";

const GRACHTENPAY = "00000000-0000-4000-8000-000000000001";
const KAASKETEN = "00000000-0000-4000-8000-000000000002";

const classifiers: Classifiers = {
  channels: [], eventTypes: [], roles: [], stages: [], exchangeItems: [],
  statuses: [
    { id: "s1", slug: "green", label: "Green", color: "green", countsAsActive: true },
    { id: "s2", slug: "amber", label: "Amber", color: "orange", countsAsActive: true },
    { id: "s3", slug: "red", label: "Red", color: "red", countsAsActive: false },
    { id: "s4", slug: "onboarding", label: "Onboarding", color: "accent", countsAsActive: false },
  ],
  forecasts: [
    { id: "f1", slug: "committed", label: "Committed", color: "green" },
    { id: "f2", slug: "likely", label: "Likely", color: "green" },
    { id: "f3", slug: "at_risk", label: "At risk", color: "red" },
  ],
  gates: ["Repo public on GitHub", "Demo video uploaded", "Pitch deck shared", "Colosseum submission filed", "Team verified in HQ"]
    .map((label, index) => ({ id: `g${index + 1}`, label })),
};

const settings: Settings = {
  prospectsReached: 0, committedManual: 0, activeAtKickoff: 0,
  staleDays: 7, finalistCap: 30, verifiedOnlyFinalists: false,
  timezone: "Europe/Amsterdam", calStart: "", calEnd: "", prospectsSub: "", activeSub: "",
};

const grachtenpay: Project = {
  id: GRACHTENPAY, name: "Grachtenpay", leadName: "Nienke Visser", leadContact: "@nienkev",
  members: [
    { id: "m1", name: "Nienke Visser", contact: "@nienkev", username: "nienkev" },
    { id: "m2", name: "Tim Kuiper", contact: "@timk", username: "timk" },
  ],
  createdAt: "2026-09-15", highPotential: true,
  colosseum: {
    url: "https://colosseum.com/arena/projects/grachtenpay", imageUrl: null,
    description: "Tap-to-pay for Amsterdam canal boats and market stalls, settled in USDC on Solana.",
    stage: "beta", category: "Payments", submissionStatus: "submitted", leadUsername: "nienkev",
    importedByName: "Nienke Visser", importedAt: "2026-09-15",
  },
  partnerId: "pt3", partnerName: "Rabobank Innovation", captainUserId: "c1", captainName: "Femke de Jong",
  eventSrc: "Kickoff Amsterdam", statusSlug: "amber", forecastSlug: "committed", gates: ["g1", "g2", "g5"],
  lastCheckIn: "2026-09-16", blocker: "Waiting on Helius RPC quota upgrade", touchedBy: "Bram", touchedAt: "2026-09-16",
  notes: [{ id: "n1", author: "Bram", body: "Team demoed canal-side QR payments, looks strong.", createdAt: "2026-09-16T15:10:00Z", editedAt: null }],
};

const kaasketen: Project = {
  id: KAASKETEN, name: "Kaasketen", leadName: "Pieter van Dijk", leadContact: "", members: [],
  createdAt: "2026-09-10", highPotential: false, colosseum: null,
  partnerId: null, partnerName: "", captainUserId: null, captainName: "", eventSrc: "",
  statusSlug: "red", forecastSlug: "at_risk", gates: [], lastCheckIn: "2026-09-05", blocker: "",
  touchedBy: "Nienke", touchedAt: "2026-09-10", notes: [],
};

const week: PeriodStatus = {
  periodId: "week-1", periodSequence: 1, mode: "weekly", startDate: "2026-09-14", endDate: "2026-09-20",
  startsAt: "2026-09-13T22:00:00Z", endsAt: "2026-09-20T22:00:00Z", nudgeAt: null, completed: true, basis: "entry",
  entries: 1, latestEntryAt: "2026-09-16T10:00:00Z", closed: false, exempt: false,
};

const reporting: ProjectReportingStatus[] = [{
  projectId: GRACHTENPAY, projectName: "Grachtenpay", hackathonId: 6, imported: true, eligibleFrom: "2026-09-14",
  paused: false, captainUserId: "c1", submissionStatus: "submitted", current: week, missedPeriods: 0, history: [week],
}];

const NOW = Date.parse("2026-09-16T18:00:00Z");

const render = (expandId: string | null = null, projects: Project[] = [grachtenpay, kaasketen]) => renderToStaticMarkup(createElement(Projects, {
  projects,
  captainOptions: [{ id: "c1", name: "Femke de Jong" }, { id: "c2", name: "Joost Vermeer" }],
  reporting, classifiers, settings, now: NOW, expandId,
}));

describe("the Projects board", () => {
  it("renders the header, New project, the filter bar and eight columns without Monday review or Source", () => {
    const html = render();
    expect(html).toMatch(/<h1[^>]*>Projects <span[^>]*>2<\/span><\/h1>/);
    expect(html).not.toContain("Monday review");
    expect(html).not.toContain("Exit review");
    expect(html).toMatch(/<button[^>]*>New project<\/button>/);
    expect(html).not.toContain("Assign Captains");
    expect(html).toContain('placeholder="Filter by name or lead"');
    expect(html).not.toContain(">All<");
    expect(html).toContain(">All forecasts<");
    expect(html).not.toContain("All sources");
    for (const toggle of ["Unassigned", "Not updated", "Missed weeks", "Not submitted"]) {
      expect(html).toMatch(new RegExp(`<button[^>]*aria-pressed="false"[^>]*>${toggle}</button>`));
    }
    const headers = [...html.matchAll(/<span(?: style="[^"]*")?>(Project|Lead|Status|Forecast|Gates|Check-in|Weekly|Blocker)<\/span>/g)].map((m) => m[1]);
    expect(headers).toEqual(["Project", "Lead", "Forecast", "Gates", "Check-in", "Weekly", "Blocker"]);
    expect(html).not.toContain(">Source<");
    expect(html).toMatch(/<a[^>]*href="\/hq\/demo"[^>]*>Demo day →<\/a>/);
    expect(html).not.toMatch(/[—·]/);
  });

  it("renders collapsed rows with HP, gates and weekly states without project statuses", () => {
    const html = render();
    expect(html.match(/role="button"[^>]*aria-expanded="false"/g)).toHaveLength(2);
    expect(html.match(/title="High potential"[^>]*>HP<\/span>/g)).toHaveLength(1);
    expect(html.match(/project-fallback\.png/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toMatch(/>(Green|Amber|Yellow|Red)</);
    expect(html).not.toContain(">Onboarding<");
    expect(html).toContain(">3/5<");
    expect(html).toContain(">0/5<");
    expect(html).toContain(">Updated<");
    expect(html).toContain(">Not in reporting<");
    // A check-in older than staleDays reads in red; a fresh one does not.
    expect(html).toMatch(/color:var\(--red\)[^"]*"[^>]*>Sep 5<\/span>/);
    expect(html).toMatch(/color:var\(--label-2\)[^"]*"[^>]*>Sep 16<\/span>/);
    expect(html.match(/>✓</g)).toHaveLength(1);
    expect(html).toContain('title="Waiting on Helius RPC quota upgrade"');
    expect(html).not.toContain("Weekly reporting");
  });

  it("expands an imported project into the four blocks, with the lead chosen from the Colosseum roster", () => {
    const html = render(GRACHTENPAY, [{ ...grachtenpay, statusSlug: "onboarding" }, kaasketen]);
    expect(html).toMatch(/role="button"[^>]*aria-expanded="true"/);
    expect(html).not.toMatch(/>(Green|Amber|Yellow|Red)</);
    expect(html).not.toMatch(/>(Onboarding|Status|Event|Partner)</);
    expect(html).toMatch(/<select id="forecast-[^"]+"[^>]*>/);
    for (const heading of ["Colosseum", "Submission gates", "Details", "Timeline"]) {
      expect(html).toMatch(new RegExp(`<(?:div|span)[^>]*>${heading}</(?:div|span)>`));
    }
    expect(html).toContain("Tap-to-pay for Amsterdam canal boats and market stalls, settled in USDC on Solana.");
    expect(html).toContain(">Beta / devnet testing<");
    expect(html).toContain(">Payments<");
    expect(html).toContain(">Submitted<");
    expect(html).toMatch(/<a[^>]*href="https:\/\/colosseum\.com\/arena\/projects\/grachtenpay"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>View on Colosseum<\/a>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>High potential ✓<\/button>/);
    expect(html).toContain("Imported from Colosseum by Nienke Visser on Sep 15.");
    // Gates: the three ticked ones, and the label colour rule.
    expect(html.match(/<input type="checkbox"[^>]*checked=""/g)).toHaveLength(3);
    expect(html).toContain("Colosseum submission filed");
    // Lead is a roster select on an imported project, and the roster is Colosseum's to change.
    expect(html).toMatch(/<select id="lead-[^"]+"[^>]*>/);
    expect(html).toMatch(/<option value="nienkev" selected="">Nienke Visser \(@nienkev\)<\/option>/);
    expect(html).toContain("<option value=\"timk\">Tim Kuiper (@timk)</option>");
    expect(html.match(/class="hq-chip-lead"[^>]*>Nienke Visser<\/button>/g)).toHaveLength(1);
    expect(html).not.toMatch(/class="hq-chip-member"[^>]*>Nienke Visser<\/button>/);
    expect(html).toMatch(/class="hq-chip-member"[^>]*>Tim Kuiper<\/button>/);
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(html).toMatch(/<option value="c1" selected="">Femke de Jong<\/option>/);
    expect(html).toContain(">No Captain<");
    expect(html).toContain("Last touched by Bram, Sep 16. Changes save as you go.");
    expect(html).toContain('aria-label="Team and captain updates"');
    expect(html).toContain("Loading updates…");
    expect(html).toContain('placeholder="Add a note"');
    expect(html).toContain("Sep 16, 17:10, Bram");
    expect(html).toContain("Team demoed canal-side QR payments, looks strong.");
    expect(html).not.toContain("Saved versions");
    expect(html).not.toContain("Add to weekly reporting");
    expect(html).not.toMatch(/[—·]/);
  });

  it("expands a project created in HQ with the unlinked Colosseum copy, a free-text lead and the team modal button", () => {
    const html = render(KAASKETEN);
    expect(html).toContain(">Unknown<");
    expect(html).toContain(">Uncategorised<");
    expect(html).toContain(">Not checked<");
    expect(html).not.toContain("View on Colosseum");
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Mark high potential<\/button>/);
    expect(html).toContain("Created in HQ on Sep 10. Not linked to a Colosseum project yet.");
    expect(html).toMatch(/<input id="lead-[^"]+"[^>]*value="Pieter van Dijk"/);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Add<\/button>/);
    expect(html).toContain("Last touched by Nienke, Sep 10. Changes save as you go.");
  });

  it("keeps a different teammate with the lead's name while matching the lead's username regardless of case", () => {
    const html = render(GRACHTENPAY, [{
      ...grachtenpay,
      colosseum: { ...grachtenpay.colosseum!, leadUsername: "NIENKEV" },
      members: [...grachtenpay.members, { id: "m3", name: "Nienke Visser", contact: "", username: "another-nienke" }],
    }]);
    expect(html.match(/class="hq-chip-lead"[^>]*>Nienke Visser<\/button>/g)).toHaveLength(1);
    expect(html.match(/class="hq-chip-member"[^>]*>Nienke Visser<\/button>/g)).toHaveLength(1);
    expect(html).toMatch(/class="hq-chip-member"[^>]*>Tim Kuiper<\/button>/);
  });

  it("shows the former lead as a teammate when another roster member becomes lead", () => {
    const html = render(GRACHTENPAY, [{
      ...grachtenpay, leadName: "Tim Kuiper",
      colosseum: { ...grachtenpay.colosseum!, leadUsername: "timk" },
    }]);
    expect(html.match(/class="hq-chip-lead"[^>]*>Tim Kuiper<\/button>/g)).toHaveLength(1);
    expect(html).not.toMatch(/class="hq-chip-member"[^>]*>Tim Kuiper<\/button>/);
    expect(html).toMatch(/class="hq-chip-member"[^>]*>Nienke Visser<\/button>/);
    expect(html).toContain('<option value="nienkev">Nienke Visser (@nienkev)</option>');
  });
});
