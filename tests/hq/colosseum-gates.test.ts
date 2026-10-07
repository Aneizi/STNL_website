// Ticking submission gates from the Colosseum snapshot, against the real
// schema on PGlite. An X handle ticks the social gate, a repo link the repo
// gate, a website the MVP gate, a pitch link the pitch gate, a demo link the
// demo gate, and Colosseum's confirmed submission (submittedAt) the submission
// gate. Each is ticked once, and an operator who unticks one wins.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { BuilderDatabase } from "@/lib/hq/builder-db";
import { gateEvidence, tickColosseumGates } from "@/lib/hq/colosseum-gates";
import { createMigratedDatabase, pgliteBuilderDatabase } from "./helpers/db";

const EDITION = 81;
const ARCHIVED = 82;
const PROJECT_A = "00000000-0000-4000-9200-000000000001";
const PROJECT_B = "00000000-0000-4000-9200-000000000002";
const OLD_PROJECT = "00000000-0000-4000-9200-000000000003";
// Crypto World's Fair's gates, plus two the snapshot cannot prove.
const GATES = ["Social profile", "Working MVP", "Repo accessible", "Pitch video, 2 min max", "Technical video, 2 min max", "Colosseum submission",
  "Colosseum registration", "All links tested"];

const PITCH = "https://www.youtube.com/watch?v=pitch";
const DEMO = "https://www.youtube.com/watch?v=demo";

let pg: PGlite;
let db: BuilderDatabase;

async function rows(text: string, values: unknown[] = []) {
  return (await pg.query(text, values)).rows as Record<string, unknown>[];
}

async function seedProject(id: string, hackathonId: number, snapshot: {
  status?: string; presentation?: string | null; pitchVideo?: string | null; technicalDemo?: string | null; demoVideo?: string | null;
  twitter?: string | null; repo?: string | null; website?: string | null;
}) {
  await rows(
    `INSERT INTO hq_projects(id,hackathon_id,name,status_id,forecast_id,last_check_in)
     SELECT $1,$2,$3,s.id,f.id,current_date FROM hq_project_statuses s CROSS JOIN hq_project_forecasts f LIMIT 1`,
    [id, hackathonId, `Project ${id.slice(-1)}`],
  );
  await rows(
    `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,raw,owner_user_id,verification,lead_username,
       submission_status,presentation_link,pitch_video_link,technical_demo_link,demo_video_link,twitter_handle,repo_link,website)
     VALUES($1,$2,$3,$4,$5,'{}','owner','verified','owner',$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, hackathonId, Math.floor(Math.random() * 1e9), `https://colosseum.com/arena/projects/${id}`, id,
      snapshot.status ?? "not_submitted", snapshot.presentation ?? null, snapshot.pitchVideo ?? null,
      snapshot.technicalDemo ?? null, snapshot.demoVideo ?? null,
      snapshot.twitter ?? null, snapshot.repo ?? null, snapshot.website ?? null],
  );
}

async function ticked(projectId: string): Promise<string[]> {
  return (await rows(
    `SELECT g.label FROM hq_project_gates pg JOIN hq_submission_gates g ON g.id = pg.gate_id
     WHERE pg.project_id = $1 ORDER BY g.sort`,
    [projectId],
  )).map((row) => String(row.label));
}

beforeAll(async () => {
  pg = await createMigratedDatabase();
  db = pgliteBuilderDatabase(pg);
  await rows(`INSERT INTO hq_builder_profiles(id,email,name) VALUES('owner','owner@example.test','Owner')`);
  await rows(`INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort) VALUES('onboarding','Onboarding','accent',true,100)`);
  await rows(`INSERT INTO hq_project_forecasts(slug,label,color,sort) VALUES('unassessed','Not assessed','muted',100)`);
}, 30_000);

afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  await pg.exec(`DELETE FROM hq_project_onboarding; DELETE FROM hq_projects; DELETE FROM hq_hackathons;`);
  await rows(`INSERT INTO hq_hackathons(id,slug,name,start_date,end_date) VALUES($1,'worlds-fair','Crypto Worlds Fair','2026-09-14','2026-10-12')`, [EDITION]);
  await rows(`INSERT INTO hq_hackathons(id,slug,name,start_date,end_date,archived_at) VALUES($1,'frontier','Frontier','2026-05-04','2026-05-31',now())`, [ARCHIVED]);
  for (const hackathonId of [EDITION, ARCHIVED]) {
    for (const [sort, label] of GATES.entries()) {
      await rows(`INSERT INTO hq_submission_gates(hackathon_id,label,sort) VALUES($1,$2,$3)`, [hackathonId, label, sort]);
    }
  }
});

describe("gate evidence", () => {
  it("recognises the gates the snapshot can prove by their wording", () => {
    expect(gateEvidence("Social profile")).toBe("social");
    expect(gateEvidence("Twitter account live")).toBe("social");
    expect(gateEvidence("Repo accessible")).toBe("repo");
    expect(gateEvidence("Repo public on GitHub")).toBe("repo");
    expect(gateEvidence("Code repository")).toBe("repo");
    expect(gateEvidence("Working MVP")).toBe("mvp");
    expect(gateEvidence("Pitch video, 2 min max")).toBe("pitch");
    expect(gateEvidence("Pitch deck shared")).toBe("pitch");
    expect(gateEvidence("Technical video, 2 min max")).toBe("demo");
    expect(gateEvidence("Demo video uploaded")).toBe("demo");
    expect(gateEvidence("Colosseum submission")).toBe("submission");
    expect(gateEvidence("Colosseum submission filed")).toBe("submission");
    for (const label of ["Colosseum registration", "All links tested", "Validation evidence", "Team profiles complete", "Ready for Demo Day"]) {
      expect(gateEvidence(label), label).toBeNull();
    }
  });
});

describe("tickColosseumGates", () => {
  it("ticks the pitch and demo gates from their links, but not the submission gate without a confirmed submission", async () => {
    await seedProject(PROJECT_A, EDITION, { presentation: PITCH, pitchVideo: PITCH, demoVideo: DEMO, technicalDemo: DEMO });
    expect(await tickColosseumGates(db)).toBe(2);
    expect(await ticked(PROJECT_A)).toEqual(["Pitch video, 2 min max", "Technical video, 2 min max"]);
  });

  it("ticks the social, repo and MVP gates from the X handle, repo link and website", async () => {
    await seedProject(PROJECT_A, EDITION, { twitter: "uavdotfun", repo: "https://github.com/uavdotfun/uavprgm", website: "https://uav.fun" });
    await seedProject(PROJECT_B, EDITION, { repo: "https://github.com/example/code" });
    expect(await tickColosseumGates(db)).toBe(4);
    expect(await ticked(PROJECT_A)).toEqual(["Social profile", "Working MVP", "Repo accessible"]);
    expect(await ticked(PROJECT_B)).toEqual(["Repo accessible"]);
  });

  it("ticks only the gate a single material proves, and leaves the submission gate alone", async () => {
    await seedProject(PROJECT_A, EDITION, { pitchVideo: PITCH });
    await seedProject(PROJECT_B, EDITION, {});
    await tickColosseumGates(db);
    expect(await ticked(PROJECT_A)).toEqual(["Pitch video, 2 min max"]);
    expect(await ticked(PROJECT_B)).toEqual([]);
  });

  it("ticks the submission gate when Colosseum has confirmed the submission", async () => {
    await seedProject(PROJECT_A, EDITION, { status: "submitted" });
    await tickColosseumGates(db);
    expect(await ticked(PROJECT_A)).toEqual(["Colosseum submission"]);
  });

  it("does not tick a gate again after an operator unticks it", async () => {
    await seedProject(PROJECT_A, EDITION, { status: "submitted", presentation: PITCH, demoVideo: DEMO });
    expect(await tickColosseumGates(db)).toBe(3);
    await rows(
      `DELETE FROM hq_project_gates WHERE project_id = $1 AND gate_id = (SELECT id FROM hq_submission_gates WHERE hackathon_id = $2 AND label = 'Colosseum submission')`,
      [PROJECT_A, EDITION],
    );
    expect(await tickColosseumGates(db)).toBe(0);
    expect(await ticked(PROJECT_A)).toEqual(["Pitch video, 2 min max", "Technical video, 2 min max"]);
  });

  it("keeps an operator's own ticks and counts only the new ones", async () => {
    await seedProject(PROJECT_A, EDITION, { presentation: PITCH, demoVideo: DEMO });
    await rows(
      `INSERT INTO hq_project_gates(project_id,gate_id) SELECT $1, id FROM hq_submission_gates WHERE hackathon_id = $2 AND label IN ('Working MVP','Pitch video, 2 min max')`,
      [PROJECT_A, EDITION],
    );
    expect(await tickColosseumGates(db)).toBe(1);
    expect(await ticked(PROJECT_A)).toEqual(["Working MVP", "Pitch video, 2 min max", "Technical video, 2 min max"]);
  });

  it("scopes to the projects or edition asked for and skips archived editions", async () => {
    await seedProject(PROJECT_A, EDITION, { presentation: PITCH, demoVideo: DEMO });
    await seedProject(PROJECT_B, EDITION, { presentation: PITCH, demoVideo: DEMO });
    await seedProject(OLD_PROJECT, ARCHIVED, { presentation: PITCH, demoVideo: DEMO });
    await tickColosseumGates(db, { projectIds: [PROJECT_B] });
    expect(await ticked(PROJECT_A)).toEqual([]);
    expect(await ticked(PROJECT_B)).toHaveLength(2);
    expect(await tickColosseumGates(db, { projectIds: [] })).toBe(0);
    await tickColosseumGates(db, { hackathonId: EDITION });
    expect(await ticked(PROJECT_A)).toHaveLength(2);
    await tickColosseumGates(db);
    expect(await ticked(OLD_PROJECT)).toEqual([]);
  });
});
