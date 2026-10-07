import "server-only";
import type { BuilderQuery } from "./builder-db";
import { hasDemoMaterial, hasPitchMaterial, type SubmissionStatus } from "./colosseum-snapshot";

/**
 * Submission gates ticked from the stored Colosseum snapshot. Each edition
 * names its own gates in Admin, so the ones a snapshot can prove are
 * recognised by their wording rather than by a fixed id.
 *
 * Each (project, gate) pair is ticked at most once: the pair is recorded in
 * hq_project_gate_autoticks, so a gate an operator unticks stays unticked.
 */

type GateEvidence = "pitch" | "demo" | "submission";

/** What a gate's label says it checks, when it is something the snapshot can prove. */
export function gateEvidence(label: string): GateEvidence | null {
  if (/\b(?:pitch|deck|presentation)\b/i.test(label)) return "pitch";
  if (/\btechnical\b|\bdemo\b(?!\s*day)/i.test(label)) return "demo";
  if (/\bsubmi(?:t|ts|tted|ssion)\b/i.test(label)) return "submission";
  return null;
}

/** The submission gate follows a confirmed submission, or both materials being in. */
function proves(evidence: GateEvidence, row: Record<string, unknown>): boolean {
  const links = {
    presentation: row.presentation_link as string | null,
    pitchVideo: row.pitch_video_link as string | null,
    technicalDemo: row.technical_demo_link as string | null,
    demoVideo: row.demo_video_link as string | null,
  };
  if (evidence === "pitch") return hasPitchMaterial(links);
  if (evidence === "demo") return hasDemoMaterial(links);
  return (row.submission_status as SubmissionStatus) === "submitted" || (hasPitchMaterial(links) && hasDemoMaterial(links));
}

/**
 * Tick every gate the stored snapshots prove and that was never auto-ticked
 * before, in live editions only. Reads the database alone, never Colosseum.
 * Returns how many gates were newly ticked.
 */
export async function tickColosseumGates(
  db: BuilderQuery,
  input: { projectIds?: readonly string[]; hackathonId?: number } = {},
): Promise<number> {
  const values: unknown[] = [];
  let scope = "";
  if (input.projectIds) {
    if (!input.projectIds.length) return 0;
    values.push([...new Set(input.projectIds)]);
    scope += ` AND o.project_id = ANY($${values.length}::uuid[])`;
  }
  if (input.hackathonId != null) {
    values.push(input.hackathonId);
    scope += ` AND p.hackathon_id = $${values.length}`;
  }
  const { rows } = await db.query(
    `SELECT o.project_id::text AS project_id, g.id::text AS gate_id, g.label, o.submission_status,
            o.presentation_link, o.pitch_video_link, o.technical_demo_link, o.demo_video_link
     FROM hq_project_onboarding o
     JOIN hq_projects p ON p.id = o.project_id
     JOIN hq_hackathons h ON h.id = p.hackathon_id AND h.archived_at IS NULL
     JOIN hq_submission_gates g ON g.hackathon_id = p.hackathon_id
     WHERE NOT EXISTS (SELECT 1 FROM hq_project_gate_autoticks a WHERE a.project_id = o.project_id AND a.gate_id = g.id)${scope}`,
    values,
  );
  const due = rows.filter((row) => {
    const evidence = gateEvidence(String(row.label));
    return evidence !== null && proves(evidence, row);
  });
  if (!due.length) return 0;
  const { rows: ticked } = await db.query(
    `WITH due(project_id, gate_id) AS (SELECT * FROM unnest($1::uuid[], $2::uuid[])),
     recorded AS (
       INSERT INTO hq_project_gate_autoticks (project_id, gate_id) SELECT project_id, gate_id FROM due
       ON CONFLICT DO NOTHING RETURNING project_id, gate_id
     )
     INSERT INTO hq_project_gates (project_id, gate_id) SELECT project_id, gate_id FROM recorded
     ON CONFLICT DO NOTHING RETURNING project_id`,
    [due.map((row) => row.project_id), due.map((row) => row.gate_id)],
  );
  return ticked.length;
}
