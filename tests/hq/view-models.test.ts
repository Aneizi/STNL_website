// The actor-aware view models carry the minimal fields their audience may
// see and nothing from the operator-side row they are mapped from.
import { describe, expect, it } from "vitest";
import type { BuilderTeam } from "@/lib/hq/builder-types";
import type { Person } from "@/lib/hq/types";
import { toCaptainAssignmentView, toCaptainLeaderboardView, toMemberTeamView, toPublicPersonView } from "@/lib/hq/view-models";

const TEAM: BuilderTeam = {
  id: "00000000-0000-4000-8000-00000000000a",
  name: "Tulip Ledger",
  hackathonId: 6,
  hackathonName: "Edition A",
  projectUrl: "https://colosseum.com/arena/projects/explore/tulip-ledger",
  description: "An imported project description.",
  stage: "mvp",
  verification: "verified",
  ownerId: "lead-a",
  leadUsername: "fictional_builder_1",
  members: [
    { id: "m1", name: "Fictional Builder One", username: "fictional_builder_1", avatarUrl: null, joined: true },
    { id: "m2", name: "Fictional Builder Two", username: "fictional_builder_2", avatarUrl: "https://static.example.test/two.png", joined: false },
  ],
  source: {
    category: "Payments & Remittance", tracks: [], twitterHandle: "tulipledger",
    website: null, repoLink: "https://github.com/example/project",
    presentationLink: null, technicalDemoLink: null, pitchVideoLink: null, demoVideoLink: null,
    imageUrl: null, submissionStatus: "submitted", submittedAt: "2026-05-11T20:00:00.000Z",
    completion: { isComplete: true, missingCount: 0 },
    sourceStatus: "ok", sourceCheckedAt: "2026-09-14T10:00:00.000Z", sourceErrorCode: null,
  },
};

const PERSON: Person = {
  id: "p1",
  name: "Fictional Builder One",
  roleId: "r1",
  contact: "one@example.test",
  notes: "operator notes",
  builderUserId: "lead-a",
  personId: "c1",
  account: { email: "one@example.test", telegramUsername: null },
  captain: true,
  tags: [{ kind: "role", label: "Builder", protected: false }, { kind: "capability", label: "Captain", protected: true }],
  removal: { cardId: "p1", name: "Fictional Builder One", hackathonId: 6, personId: "c1", hasAccount: true, rosterRows: 1, otherEditionCards: 0, judgeScores: 0, enrollments: 1 },
};

describe("toMemberTeamView", () => {
  it("carries the team page's fields, the viewer's own membership and the Captain's approved contact, and no other account's identity", () => {
    const view = toMemberTeamView(TEAM, { id: "lead-a" }, { displayName: "Captain", contact: "@cap_handle" });
    expect(view).toEqual({
      id: TEAM.id,
      name: "Tulip Ledger",
      edition: { id: 6, name: "Edition A" },
      membership: { role: "owner", verification: "verified" },
      captain: { displayName: "Captain", contact: "@cap_handle" },
      projectUrl: TEAM.projectUrl,
      stage: "mvp",
      lead: { username: "fictional_builder_1" },
      // The normalized Colosseum snapshot, carried whole: it is public
      // project information, and phase 3's handoff has every later view read
      // this one shape.
      source: TEAM.source,
      roster: [
        { id: "m1", name: "Fictional Builder One", username: "fictional_builder_1", avatarUrl: null, joined: true },
        { id: "m2", name: "Fictional Builder Two", username: "fictional_builder_2", avatarUrl: "https://static.example.test/two.png", joined: false },
      ],
    });
    expect(Object.keys(view).sort()).toEqual(["captain", "edition", "id", "lead", "membership", "name", "projectUrl", "roster", "source", "stage"]);
    for (const row of view.roster) expect(Object.keys(row).sort()).toEqual(["avatarUrl", "id", "joined", "name", "username"]);
    expect(JSON.stringify(view)).not.toMatch(/lead-a|ownerId|description|hackathonName/);
    expect(toMemberTeamView(TEAM, { id: "member-a" }).membership).toEqual({ role: "member", verification: "verified" });
    expect(toMemberTeamView(TEAM, { id: "member-a" }).captain).toBeNull();
  });

  it("keeps a wider Captain record down to the two approved fields", () => {
    const captain = { displayName: "Captain", contact: null, email: "cap@example.test", userId: "cap" };
    expect(toMemberTeamView(TEAM, { id: "lead-a" }, captain).captain).toEqual({ displayName: "Captain", contact: null });
  });
});

describe("toCaptainAssignmentView", () => {
  it("carries the minimal team and roster fields and no member ids or operator state", () => {
    const view = toCaptainAssignmentView(TEAM);
    expect(view).toEqual({
      id: TEAM.id,
      name: "Tulip Ledger",
      edition: { id: 6, name: "Edition A" },
      projectUrl: TEAM.projectUrl,
      stage: "mvp",
      lead: { username: "fictional_builder_1" },
      source: TEAM.source,
      roster: [
        { name: "Fictional Builder One", username: "fictional_builder_1", avatarUrl: null, joined: true },
        { name: "Fictional Builder Two", username: "fictional_builder_2", avatarUrl: "https://static.example.test/two.png", joined: false },
      ],
    });
    expect(Object.keys(view).sort()).toEqual(["edition", "id", "lead", "name", "projectUrl", "roster", "source", "stage"]);
    for (const row of view.roster) expect(Object.keys(row).sort()).toEqual(["avatarUrl", "joined", "name", "username"]);
  });
});

describe("toCaptainLeaderboardView", () => {
  const row = { captainUserId: "cap-1", displayName: "Fictional Captain", assignedCount: 3 };

  it("carries rank, display name, assigned count and isYou — never the raw captain id it was given", () => {
    const view = toCaptainLeaderboardView(row, 1, "cap-1");
    expect(view).toEqual({ rank: 1, displayName: "Fictional Captain", assignedCount: 3, isYou: true });
    expect(Object.keys(view).sort()).toEqual(["assignedCount", "displayName", "isYou", "rank"]);
    expect(JSON.stringify(view)).not.toContain("cap-1");
  });

  it("marks isYou false for a different viewer, and for every row when there is no viewer at all", () => {
    expect(toCaptainLeaderboardView(row, 2, "cap-2").isYou).toBe(false);
    expect(toCaptainLeaderboardView(row, 2, null).isYou).toBe(false);
  });
});

describe("toPublicPersonView", () => {
  it("is the name and the role tag labels, and leaves the capability labels out by default", () => {
    expect(toPublicPersonView(PERSON)).toEqual({ name: "Fictional Builder One", tags: ["Builder"] });
    expect(Object.keys(toPublicPersonView(PERSON)).sort()).toEqual(["name", "tags"]);
    // A surface that renders to members who are not Captains cannot leak the
    // Captain label by forgetting to filter: it has to ask for it.
    expect(toPublicPersonView(PERSON, {}).tags).not.toContain("Captain");
    expect(toPublicPersonView(PERSON, { includeCapabilities: false }).tags).not.toContain("Captain");
  });

  it("includes the capability labels for a Captain or operator surface that opts in", () => {
    expect(toPublicPersonView(PERSON, { includeCapabilities: true })).toEqual({ name: "Fictional Builder One", tags: ["Builder", "Captain"] });
  });
});
