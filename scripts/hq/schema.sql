-- Campaign HQ schema. Idempotent: every statement is IF NOT EXISTS.
-- Classifiers live here as tables (not in code) so the public repo carries
-- no campaign-specific taxonomy; the values are seeded from the gitignored
-- scripts/hq/seed-data.json (see scripts/hq/seed.ts).
--
-- IF NOT EXISTS means an edit to a table below does NOT reach a database
-- that already has that table: changes to existing columns and constraints
-- belong in scripts/hq/upgrades.ts, which runs right after this file.

CREATE TABLE IF NOT EXISTS hq_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  password_version int NOT NULL DEFAULT 1,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hq_login_attempts (
  id bigserial PRIMARY KEY,
  username text NOT NULL,
  ip text NOT NULL,
  success boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hq_login_attempts_username_idx
  ON hq_login_attempts (username, created_at);

CREATE INDEX IF NOT EXISTS hq_login_attempts_ip_idx
  ON hq_login_attempts (ip, created_at);

-- Retention deletes scan by age alone.
CREATE INDEX IF NOT EXISTS hq_login_attempts_created_idx
  ON hq_login_attempts (created_at);

-- Fixed-window login rate-limit counters: one atomically upserted row per
-- key ("ip:…" / "user:…@…"), so blocked traffic can never grow a table.
CREATE TABLE IF NOT EXISTS hq_login_limits (
  key text PRIMARY KEY,
  count int NOT NULL,
  window_start timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS hq_login_limits_window_idx
  ON hq_login_limits (window_start);

-- Server-side session records. Logout and password changes delete rows, so
-- a copied token dies with the session instead of living until JWT expiry.
CREATE TABLE IF NOT EXISTS hq_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES hq_users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS hq_sessions_user_idx
  ON hq_sessions (user_id);

CREATE TABLE IF NOT EXISTS hq_partner_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL UNIQUE,
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hq_event_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL UNIQUE,
  supports_end_date boolean NOT NULL DEFAULT false,
  sort int NOT NULL DEFAULT 0
);

-- color/bg are design-token keys (e.g. 'accent', 'accent-fill') rendered
-- as var(--<key>); filter_label is the plural used by the People filter chips.
CREATE TABLE IF NOT EXISTS hq_people_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL UNIQUE,
  filter_label text NOT NULL,
  color text NOT NULL,
  bg text NOT NULL,
  is_judge boolean NOT NULL DEFAULT false,
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hq_partner_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  drop_color text NOT NULL,
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hq_project_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  color text NOT NULL,
  counts_as_active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hq_project_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  color text NOT NULL,
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hq_submission_gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL UNIQUE,
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hq_exchange_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hq_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  channel_id uuid NOT NULL REFERENCES hq_partner_channels (id),
  captain_name text NOT NULL DEFAULT '',
  captain_contact text NOT NULL DEFAULT '',
  stage_id uuid NOT NULL REFERENCES hq_partner_stages (id),
  target int NOT NULL DEFAULT 10,
  touched_by_user_id uuid REFERENCES hq_users (id) ON DELETE SET NULL,
  touched_at date,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- event_src is free text matched to events by normalized name, mirroring
-- the design: a project can name a source event that is not tracked yet.
CREATE TABLE IF NOT EXISTS hq_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  lead_name text NOT NULL DEFAULT '',
  lead_contact text NOT NULL DEFAULT '',
  partner_id uuid REFERENCES hq_partners (id) ON DELETE SET NULL,
  event_src text NOT NULL DEFAULT '',
  status_id uuid NOT NULL REFERENCES hq_project_statuses (id),
  forecast_id uuid NOT NULL REFERENCES hq_project_forecasts (id),
  last_check_in date NOT NULL,
  blocker text NOT NULL DEFAULT '',
  touched_by_user_id uuid REFERENCES hq_users (id) ON DELETE SET NULL,
  touched_at date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hq_projects_partner_idx
  ON hq_projects (partner_id);

CREATE TABLE IF NOT EXISTS hq_project_gates (
  project_id uuid NOT NULL REFERENCES hq_projects (id) ON DELETE CASCADE,
  gate_id uuid NOT NULL REFERENCES hq_submission_gates (id),
  PRIMARY KEY (project_id, gate_id)
);

-- edited_at stays null until a note is rewritten; the timeline reads it as
-- the "(edited)" marker, so ordering still follows created_at.
CREATE TABLE IF NOT EXISTS hq_project_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES hq_projects (id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES hq_users (id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz
);

CREATE INDEX IF NOT EXISTS hq_project_notes_project_idx
  ON hq_project_notes (project_id, created_at DESC);

-- Individually editable teammates with contacts; the lead lives on the
-- project row and is always on the team. sort preserves display order.
-- Databases that predate this table have their old comma-joined members
-- migrated in by scripts/hq/upgrades.ts.
CREATE TABLE IF NOT EXISTS hq_project_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES hq_projects (id) ON DELETE CASCADE,
  name text NOT NULL,
  contact text NOT NULL DEFAULT '',
  sort int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS hq_project_members_project_idx
  ON hq_project_members (project_id, sort);

CREATE TABLE IF NOT EXISTS hq_partner_exchange (
  partner_id uuid NOT NULL REFERENCES hq_partners (id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES hq_exchange_items (id),
  PRIMARY KEY (partner_id, item_id)
);

CREATE TABLE IF NOT EXISTS hq_partner_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES hq_partners (id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES hq_users (id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hq_partner_contacts_partner_idx
  ON hq_partner_contacts (partner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hq_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  role_id uuid NOT NULL REFERENCES hq_people_roles (id),
  org text NOT NULL DEFAULT '',
  contact text NOT NULL DEFAULT '',
  partner_id uuid REFERENCES hq_partners (id) ON DELETE SET NULL,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hq_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  date date NOT NULL,
  end_date date,
  type_id uuid NOT NULL REFERENCES hq_event_types (id),
  venue text NOT NULL DEFAULT '',
  cohost text NOT NULL DEFAULT '',
  attendance int NOT NULL DEFAULT 0,
  leads int NOT NULL DEFAULT 0,
  spend int NOT NULL DEFAULT 0,
  -- Luma-sourced events carry the calendar's event id; NULL means the event
  -- was added by hand in HQ. There is deliberately no separate "source"
  -- column, so the two can never disagree.
  luma_id text UNIQUE,
  luma_url text NOT NULL DEFAULT '',
  -- Column names of Luma-backed fields an HQ edit has pinned; the sync leaves
  -- these alone. See PINNABLE in lib/hq/actions/events.ts.
  pinned_fields text[] NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  -- 'manual' survives every sync; 'missing' clears if the event reappears in
  -- Luma. Without the distinction, active Luma events (which are present in
  -- every sync) would un-archive themselves within minutes.
  archived_reason text CHECK (archived_reason IN ('manual', 'missing')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Single row. Holds the last successful Luma sync, and doubles as the lock
-- concurrent syncs serialise on (SELECT ... FOR UPDATE).
CREATE TABLE IF NOT EXISTS hq_luma_sync (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_success_at timestamptz NOT NULL DEFAULT 'epoch'
);

INSERT INTO hq_luma_sync (id) VALUES (true) ON CONFLICT DO NOTHING;

-- Databases created before the demo-day integrity constraints below are
-- upgraded in code by scripts/hq/migrate.ts (constraint rewrites and the
-- judge_name → judge_id migration cannot be expressed as IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS hq_finalists (
  project_id uuid PRIMARY KEY REFERENCES hq_projects (id) ON DELETE CASCADE,
  -- unique so concurrent max+1 inserts cannot assign the same slot
  position int NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS hq_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  sponsor text NOT NULL DEFAULT '',
  amount int NOT NULL DEFAULT 0,
  -- a winner must be a current finalist; removing the finalist clears it
  winner_project_id uuid REFERENCES hq_finalists (project_id) ON DELETE SET NULL,
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hq_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- judges are stable person ids, not mutable names
  judge_id uuid NOT NULL REFERENCES hq_people (id) ON DELETE CASCADE,
  -- only current finalists can hold scores; removal clears their scores
  project_id uuid NOT NULL REFERENCES hq_finalists (project_id) ON DELETE CASCADE,
  score int NOT NULL CHECK (score BETWEEN 1 AND 10),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (judge_id, project_id)
);

CREATE TABLE IF NOT EXISTS hq_activity (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES hq_users (id) ON DELETE SET NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hq_activity_created_idx
  ON hq_activity (created_at DESC);

CREATE TABLE IF NOT EXISTS hq_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL,
  label text NOT NULL
);

CREATE TABLE IF NOT EXISTS hq_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

-- The campaign's shared URLs (Links tab), each carrying a running note log.
-- touched_* mirrors the auditing on projects and partners.
CREATE TABLE IF NOT EXISTS hq_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  url text NOT NULL,
  highlighted boolean NOT NULL DEFAULT false,
  touched_by_user_id uuid REFERENCES hq_users (id) ON DELETE SET NULL,
  touched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hq_link_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES hq_links (id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES hq_users (id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hq_link_notes_link_idx
  ON hq_link_notes (link_id, created_at DESC);
