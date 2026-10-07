-- Submission gates HQ ticked from a team's Colosseum snapshot (a pitch, a demo,
-- or the submission itself). One row per (project, gate) ever auto-ticked, so
-- a gate an operator unticks afterwards is not ticked again.
CREATE TABLE IF NOT EXISTS hq_project_gate_autoticks (
  project_id uuid NOT NULL REFERENCES hq_projects (id) ON DELETE CASCADE,
  gate_id uuid NOT NULL REFERENCES hq_submission_gates (id) ON DELETE CASCADE,
  ticked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, gate_id)
);
