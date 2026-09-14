-- Additive public HQ onboarding tables. Apply after schema.sql and upgrades.ts.
-- Public identities never reference hq_users, the operator authentication table.
--
-- email is the verified login address, or NULL for an account that signed in
-- without one (Telegram). The internal placeholder address is never stored
-- here. contact_email is optional and self-declared: it is never copied from
-- the login address, never a placeholder, and never a way to sign in.
CREATE TABLE IF NOT EXISTS hq_builder_profiles (
  id text PRIMARY KEY,
  email text,
  contact_email text,
  name text NOT NULL,
  tier text NOT NULL DEFAULT 'regular' CHECK (tier IN ('regular', 'member')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hq_builder_profiles ALTER COLUMN email DROP NOT NULL;
ALTER TABLE hq_builder_profiles ADD COLUMN IF NOT EXISTS contact_email text;

CREATE TABLE IF NOT EXISTS hq_hackathon_onboarding (
  hackathon_id int PRIMARY KEY REFERENCES hq_hackathons(id) ON DELETE CASCADE,
  external_hackathon_id int CHECK (external_hackathon_id > 0),
  external_hackathon_slug text,
  projects_open boolean NOT NULL DEFAULT false,
  projects_available_at timestamptz,
  signup_url text NOT NULL DEFAULT 'https://colosseum.com/signup',
  hosting_enabled boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS hq_builder_enrollments (
  user_id text NOT NULL REFERENCES hq_builder_profiles(id) ON DELETE CASCADE,
  hackathon_id int NOT NULL REFERENCES hq_hackathons(id) ON DELETE CASCADE,
  participation text NOT NULL DEFAULT 'builder' CHECK (participation IN ('builder','supporter')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, hackathon_id)
);

ALTER TABLE hq_people ADD COLUMN IF NOT EXISTS builder_user_id text REFERENCES hq_builder_profiles(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hq_people_builder_idx ON hq_people(hackathon_id, builder_user_id);

CREATE TABLE IF NOT EXISTS hq_project_onboarding (
  project_id uuid PRIMARY KEY REFERENCES hq_projects(id) ON DELETE CASCADE,
  hackathon_id int NOT NULL REFERENCES hq_hackathons(id) ON DELETE CASCADE,
  external_id int NOT NULL,
  project_url text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  country text,
  raw jsonb NOT NULL,
  owner_user_id text NOT NULL REFERENCES hq_builder_profiles(id),
  verification text NOT NULL DEFAULT 'pending' CHECK (verification IN ('pending','verified','rejected')),
  stage text NOT NULL DEFAULT 'idea' CHECK (stage IN ('idea','mvp','beta','live','revenue','growth')),
  lead_username text NOT NULL,
  high_potential boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hackathon_id, external_id)
);

ALTER TABLE hq_project_members ADD COLUMN IF NOT EXISTS colosseum_username text;
ALTER TABLE hq_project_members ADD COLUMN IF NOT EXISTS builder_user_id text REFERENCES hq_builder_profiles(id) ON DELETE SET NULL;
ALTER TABLE hq_project_members ADD COLUMN IF NOT EXISTS joined_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS hq_roster_username_idx ON hq_project_members(project_id, lower(colosseum_username));
CREATE UNIQUE INDEX IF NOT EXISTS hq_roster_builder_idx ON hq_project_members(project_id, builder_user_id);

CREATE TABLE IF NOT EXISTS hq_team_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES hq_project_onboarding(project_id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES hq_project_members(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES hq_builder_profiles(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 days'),
  consumed_by text REFERENCES hq_builder_profiles(id),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hq_invites_member_idx ON hq_team_invites(member_id);

CREATE TABLE IF NOT EXISTS hq_project_import_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES hq_builder_profiles(id) ON DELETE CASCADE,
  hackathon_id int NOT NULL REFERENCES hq_hackathons(id) ON DELETE CASCADE,
  project_url text NOT NULL,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, hackathon_id, project_url)
);

CREATE TABLE IF NOT EXISTS hq_event_host_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES hq_builder_profiles(id) ON DELETE CASCADE,
  hackathon_id int NOT NULL REFERENCES hq_hackathons(id) ON DELETE CASCADE,
  title text NOT NULL,
  details text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- CRM person identity. One row per human the CRM knows about, stable across
-- editions and independent of any login. A person may be linked to at most
-- one public account and an account to at most one person. For someone who
-- only appears on an imported Colosseum roster, the normalized username
-- (lower case, no leading @) is a PROVISIONAL match key, and the display name
-- is never a key. Edition-specific People cards and roster rows point at the
-- person, so a correction moves one link instead of re-keying every edition.
CREATE TABLE IF NOT EXISTS hq_crm_persons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  normalized_colosseum_username text,
  builder_user_id text UNIQUE REFERENCES hq_builder_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hq_crm_persons_username_idx ON hq_crm_persons (normalized_colosseum_username) WHERE normalized_colosseum_username IS NOT NULL;
ALTER TABLE hq_people ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES hq_crm_persons(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hq_people_person_idx ON hq_people (hackathon_id, person_id) WHERE person_id IS NOT NULL;
ALTER TABLE hq_project_members ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES hq_crm_persons(id) ON DELETE SET NULL;
-- Backfill for a populated database: every existing account gets its person,
-- and every People card already tied to an account gets stamped with it.
-- Both match nothing on a fresh database and on every later run. A card is
-- skipped when another card in the same edition already carries the person,
-- so a re-run can never trip the one card per person per edition index.
INSERT INTO hq_crm_persons (display_name, builder_user_id) SELECT p.name, p.id FROM hq_builder_profiles p WHERE NOT EXISTS (SELECT 1 FROM hq_crm_persons c WHERE c.builder_user_id = p.id);
UPDATE hq_people SET person_id = c.id FROM hq_crm_persons c WHERE hq_people.person_id IS NULL AND hq_people.builder_user_id IS NOT NULL AND c.builder_user_id = hq_people.builder_user_id AND NOT EXISTS (SELECT 1 FROM hq_people q WHERE q.hackathon_id = hq_people.hackathon_id AND q.person_id = c.id);

-- Admin-controlled account capabilities. A capability is written only by
-- lib/hq/capabilities.ts and is never derived from a People role, a tag or
-- the membership tier. One active grant per account and capability. A revoked
-- grant stays as history. granted_by_user_id and revoked_by_user_id name the
-- operator who acted, which never makes the public account an operator.
CREATE TABLE IF NOT EXISTS hq_account_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES hq_builder_profiles(id) ON DELETE CASCADE,
  capability text NOT NULL CONSTRAINT hq_account_capabilities_capability_check CHECK (capability IN ('captain')),
  granted_by_user_id uuid REFERENCES hq_users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by_user_id uuid REFERENCES hq_users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS hq_account_capabilities_active_idx ON hq_account_capabilities (user_id, capability) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS hq_account_capabilities_capability_idx ON hq_account_capabilities (capability) WHERE revoked_at IS NULL;

-- Append-only audit of grants, revocations, identity links and assignment
-- changes. metadata holds small structural facts (ids, a reason, counts) and
-- never a note body. Rows are inserted by lib/hq/audit.ts and nothing updates
-- or deletes them.
CREATE TABLE IF NOT EXISTS hq_audit_events (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('operator','member','system')),
  actor_id text,
  subject_user_id text,
  hackathon_id integer REFERENCES hq_hackathons(id) ON DELETE SET NULL,
  project_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hq_audit_events_subject_idx ON hq_audit_events (subject_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hq_audit_events_kind_idx ON hq_audit_events (kind, created_at DESC);

-- Permission to be messaged by the HQ Telegram bot. Separate from the Telegram
-- identity in hq_auth_telegram_identity: connecting Telegram never implies
-- consent, declining changes nothing about website access, and disconnecting
-- Telegram revokes it. Written only by lib/hq/telegram-consent.ts. Nothing is
-- delivered before phase 7, which extends this table with chat state.
CREATE TABLE IF NOT EXISTS hq_telegram_bot_consent (
  user_id text PRIMARY KEY REFERENCES hq_builder_profiles(id) ON DELETE CASCADE,
  telegram_user_id bigint NOT NULL,
  messaging_enabled boolean NOT NULL DEFAULT false,
  consented_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A Captain invitation: an admin-generated bearer token that grants the
-- 'captain' capability to whoever redeems it. Only the token's hash is ever
-- stored, never the bearer value itself. Written only by the invitation
-- service (task T4.2). max_redemptions and expires_at are always finite: the
-- admin form supplies a default of one account and seven days, the schema
-- only requires a positive count and a real timestamp. Revoking an
-- invitation stops future redemptions without touching the rows already
-- granted.
CREATE TABLE IF NOT EXISTS hq_captain_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  label text,
  capability text NOT NULL CONSTRAINT hq_captain_invitations_capability_check CHECK (capability IN ('captain')),
  max_redemptions int NOT NULL CONSTRAINT hq_captain_invitations_max_redemptions_check CHECK (max_redemptions > 0),
  expires_at timestamptz NOT NULL,
  created_by_user_id uuid REFERENCES hq_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES hq_users(id) ON DELETE SET NULL
);

-- One row per distinct HQ account that redeemed an invitation, so capacity
-- counts unique accounts rather than clicks, Telegram connections or repeat
-- logins. The UNIQUE constraint below is what a redeeming transaction relies
-- on to refuse a second grant to the same account under the same invitation;
-- its leading column already serves a `WHERE invitation_id = ...` usage
-- listing and capacity count, so no separate index on invitation_id is
-- needed. user_id is nullable with ON DELETE SET NULL, unlike the ON DELETE
-- CASCADE on hq_account_capabilities.user_id: the plan requires that
-- removing an account never replenishes an old invitation's usage allowance,
-- so this row (and the redemption seat it used) must outlive the account it
-- names rather than disappear with it. Nothing at the schema level can
-- forbid a NULL user_id at insert time without giving up that same ON DELETE
-- SET NULL; the redemption service (task T4.2) must never insert a
-- redemption row without a real user_id, since a NULL one would consume a
-- seat, grant nobody, and (NULL never equalling NULL) be repeatable past
-- the UNIQUE constraint above.
CREATE TABLE IF NOT EXISTS hq_captain_invitation_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL REFERENCES hq_captain_invitations(id) ON DELETE CASCADE,
  user_id text REFERENCES hq_builder_profiles(id) ON DELETE SET NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invitation_id, user_id)
);

-- The current Captain of a project, plus its history in one table.
-- unassigned_at IS NULL marks a row as current; the partial unique index
-- below is what refuses a second current row for the same project at the
-- database rather than the application. Ending an assignment sets
-- unassigned_at instead of deleting the row, so the history stays queryable
-- after a reassignment. captain_user_id is nullable with ON DELETE SET NULL,
-- the same convention as hq_project_members.builder_user_id, so a deleted
-- account does not erase who held the seat; loadCurrentAssignment in
-- lib/hq/authz-sql.ts additionally requires captain_user_id IS NOT NULL so
-- an orphaned row from that rare case is never read back as a live
-- assignment. Both partial indexes below carry the same
-- "captain_user_id IS NOT NULL" filter as that loader: without it, a
-- project whose current Captain's account was deleted would still hold its
-- one "current" slot in the unique index (a row nobody can read back as a
-- live assignment, yet nobody could ever be assigned to replace), and its
-- orphaned row would surface as a NULL group in the leaderboard's
-- GROUP BY captain_user_id. Written only by the assignment service
-- (task T4.4).
CREATE TABLE IF NOT EXISTS hq_captain_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES hq_projects(id) ON DELETE CASCADE,
  captain_user_id text REFERENCES hq_builder_profiles(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by_user_id uuid REFERENCES hq_users(id) ON DELETE SET NULL,
  unassigned_at timestamptz,
  unassigned_by_user_id uuid REFERENCES hq_users(id) ON DELETE SET NULL,
  reason text
);
-- hq_captain_assignments_current_idx and hq_captain_assignments_captain_idx
-- were this pair's first-round (task T4.1) names, with a predicate that
-- missed "AND captain_user_id IS NOT NULL". They are retired here, by name,
-- rather than reused: reusing a name means pairing it with
-- CREATE ... IF NOT EXISTS under the corrected predicate, and since neither
-- statement's IF-condition ever changes, both would run for real on every
-- future migrate forever, not just this one transition — an unwrapped
-- DROP then CREATE on every deploy, with a real window between them where
-- the "one current Captain" invariant is unenforced, and a real unique-index
-- rebuild every time instead of converging to a no-op. Retiring the name
-- instead makes both statements permanent no-ops after the first run: the
-- old name is gone and stays gone, the new one exists and stays. Do not
-- re-add a CREATE for either name below.
DROP INDEX IF EXISTS hq_captain_assignments_current_idx;
DROP INDEX IF EXISTS hq_captain_assignments_captain_idx;
CREATE UNIQUE INDEX IF NOT EXISTS hq_captain_assignments_one_current_idx ON hq_captain_assignments (project_id) WHERE unassigned_at IS NULL AND captain_user_id IS NOT NULL;
-- The leaderboard's indexed aggregate: current assignments grouped by
-- Captain, joined to hq_projects.hackathon_id to scope the count to the
-- selected edition's active projects.
CREATE INDEX IF NOT EXISTS hq_captain_assignments_captain_current_idx ON hq_captain_assignments (captain_user_id) WHERE unassigned_at IS NULL AND captain_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Phase 3: the Colosseum source snapshot, self-service imports and joining.
--
-- The normalized snapshot lives on hq_project_onboarding rather than in a new
-- table: that row already IS the project's source mapping (external_id,
-- project_url, slug, description, country, raw), and a second table holding
-- the same mapping would be the "competing source of truth" the plan's data
-- contract forbids. Every column below is a queryable projection of the
-- bounded `raw` snapshot beside it, written only by lib/hq/builder-store.ts.
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS tracks text[] NOT NULL DEFAULT '{}';
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS twitter_handle text;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS repo_link text;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS presentation_link text;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS technical_demo_link text;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS pitch_video_link text;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS demo_video_link text;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS image_url text;
-- The external edition the snapshot actually came from, recorded beside the
-- admin-entered mapping in hq_hackathon_onboarding rather than instead of it:
-- the mapping is what an import is checked against, this is what was found.
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS external_hackathon_id int;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS external_hackathon_slug text;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS external_hackathon_name text;
-- Submission and readiness are separate concepts and separate columns.
-- submitted_at is Colosseum's own signal; completion_* is the readiness
-- diagnostic that must never drive a Submitted badge.
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS completion_is_complete boolean;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS completion_missing_count int;
-- 'not_checked' is the honest default and the value a failed refresh never
-- overwrites a known status with. Written from
-- lib/hq/colosseum-snapshot.ts#interpretSubmission and nowhere else, so the
-- "what does a null submittedAt mean" assumption has exactly one home.
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS submission_status text NOT NULL DEFAULT 'not_checked' CONSTRAINT hq_project_onboarding_submission_status_check CHECK (submission_status IN ('not_checked','submitted','not_submitted'));
-- Freshness and troubleshooting: when the source was last read successfully,
-- and what went wrong on the last failure. source_error_code is HQ's own
-- ColosseumErrorCode; source_error_message is Colosseum's own text, kept for
-- operators only and never rendered as markup.
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS source_status text NOT NULL DEFAULT 'never' CONSTRAINT hq_project_onboarding_source_status_check CHECK (source_status IN ('never','ok','error'));
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS source_checked_at timestamptz;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS source_error_code text;
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS source_error_message text;
-- The ownership-proof challenge is gone (owner change, 14 September 2026:
-- imports are self-service, gated on country plus the configured external
-- edition id, with no verification step). Its two evidence columns and the
-- short-lived challenge table have no writer and no reader left, so they are
-- removed rather than left as vestigial state an operator could misread as a
-- review step that still happens.
ALTER TABLE hq_project_onboarding DROP COLUMN IF EXISTS proof_comment_id;
ALTER TABLE hq_project_onboarding DROP COLUMN IF EXISTS proof_author_id;
DROP TABLE IF EXISTS hq_project_challenges;

-- Roster avatars come from the imported snapshot. Decorative; never a login.
ALTER TABLE hq_project_members ADD COLUMN IF NOT EXISTS avatar_url text;

-- Backfill the normalized fields from the snapshot each row already holds,
-- matched by the row's own raw payload rather than by name. Every statement
-- is guarded on the column still being NULL, so each one matches nothing on a
-- fresh database, nothing on a re-run, and never overwrites a later refresh.
UPDATE hq_project_onboarding SET category = raw->'project'->>'category' WHERE category IS NULL AND raw->'project'->>'category' IS NOT NULL;
UPDATE hq_project_onboarding SET twitter_handle = raw->'project'->>'twitterHandle' WHERE twitter_handle IS NULL AND raw->'project'->>'twitterHandle' IS NOT NULL;
UPDATE hq_project_onboarding SET website = raw->'project'->>'website' WHERE website IS NULL AND raw->'project'->>'website' IS NOT NULL;
UPDATE hq_project_onboarding SET repo_link = raw->'project'->>'repoLink' WHERE repo_link IS NULL AND raw->'project'->>'repoLink' IS NOT NULL;
UPDATE hq_project_onboarding SET presentation_link = raw->'project'->>'presentationLink' WHERE presentation_link IS NULL AND raw->'project'->>'presentationLink' IS NOT NULL;
UPDATE hq_project_onboarding SET technical_demo_link = raw->'project'->>'technicalDemoLink' WHERE technical_demo_link IS NULL AND raw->'project'->>'technicalDemoLink' IS NOT NULL;
UPDATE hq_project_onboarding SET pitch_video_link = raw->'project'->>'pitchVideoLink' WHERE pitch_video_link IS NULL AND raw->'project'->>'pitchVideoLink' IS NOT NULL;
UPDATE hq_project_onboarding SET demo_video_link = raw->'project'->>'demoVideoLink' WHERE demo_video_link IS NULL AND raw->'project'->>'demoVideoLink' IS NOT NULL;
UPDATE hq_project_onboarding SET image_url = raw->'project'->'image'->>'url' WHERE image_url IS NULL AND raw->'project'->'image'->>'url' IS NOT NULL;
UPDATE hq_project_onboarding SET external_hackathon_id = (raw->'project'->'hackathon'->>'id')::int WHERE external_hackathon_id IS NULL AND (raw->'project'->'hackathon'->>'id') ~ '^[0-9]+$';
UPDATE hq_project_onboarding SET external_hackathon_slug = raw->'project'->'hackathon'->>'slug' WHERE external_hackathon_slug IS NULL AND raw->'project'->'hackathon'->>'slug' IS NOT NULL;
UPDATE hq_project_onboarding SET external_hackathon_name = raw->'project'->'hackathon'->>'name' WHERE external_hackathon_name IS NULL AND raw->'project'->'hackathon'->>'name' IS NOT NULL;
UPDATE hq_project_onboarding SET tracks = ARRAY(SELECT jsonb_array_elements_text(raw->'project'->'tracks')) WHERE tracks = '{}' AND jsonb_typeof(raw->'project'->'tracks') = 'array' AND jsonb_array_length(raw->'project'->'tracks') > 0;
-- The raw snapshot is proof the source was read successfully once, at import
-- time. submission_status is deliberately NOT backfilled: no phase 3 status
-- check has run for these rows, and "Not checked" is the honest answer until
-- one does.
UPDATE hq_project_onboarding SET source_status = 'ok', source_checked_at = created_at WHERE source_status = 'never';

-- ---------------------------------------------------------------------------
-- Phase 5: weekly reporting. Periods, project eligibility, entries, an
-- append-only revision per version, and one persisted outcome per project and
-- closed period.
--
-- These tables live here rather than in schema.sql because an entry's author
-- and an eligibility row's enabling operator both belong to the public
-- account side, and because upgrades.ts runs before hq_builder_profiles
-- exists (migration convention 2's DDL-PLACEMENT ruling).

-- Per-edition reporting configuration. Deliberately thin: the reporting
-- window itself is hq_hackathons.start_date/end_date and the timezone is
-- hq_settings.timezone, both already operator-editable, and duplicating
-- either here would create the competing source of truth the data contract
-- forbids. What is left is the settings that have no home yet: the explicit
-- final-period start (the "merge setting" the plan requires so the last
-- weeks become one submission-focus window instead of hardcoded dates in a
-- component), the official external submission deadline when it differs from
-- HQ's own window, and the mid-period nudge weekday and local time, stored so
-- that phase 8 can change them without editing bot code.
CREATE TABLE IF NOT EXISTS hq_reporting_config (
  hackathon_id int PRIMARY KEY REFERENCES hq_hackathons(id) ON DELETE CASCADE,
  final_period_start_date date,
  official_submission_deadline timestamptz,
  nudge_weekday int NOT NULL DEFAULT 3 CONSTRAINT hq_reporting_config_nudge_weekday_check CHECK (nudge_weekday BETWEEN 1 AND 7),
  nudge_time time NOT NULL DEFAULT '12:00',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per reporting period, written once reporting begins so that an
-- entry and an outcome reference a stable period id rather than a pair of
-- dates that an admin could later edit out from under them. start_date and
-- end_date are the INCLUSIVE local dates a screen displays; starts_at and
-- ends_at are the UTC instants a comparison uses, with ends_at EXCLUSIVE, so
-- one period's ends_at is exactly the next one's starts_at and no instant
-- belongs to two periods. `sequence` is the period's identity within the
-- edition, which is why the schedule generator is deterministic: a stored
-- period is matched to a regenerated one by sequence, never by its dates.
-- closed_at is set by closePeriod once its outcomes are persisted.
CREATE TABLE IF NOT EXISTS hq_reporting_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id int NOT NULL REFERENCES hq_hackathons(id) ON DELETE CASCADE,
  sequence int NOT NULL CONSTRAINT hq_reporting_periods_sequence_check CHECK (sequence > 0),
  mode text NOT NULL CONSTRAINT hq_reporting_periods_mode_check CHECK (mode IN ('weekly','submission')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  nudge_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_reporting_periods_window_check CHECK (ends_at > starts_at AND end_date >= start_date),
  UNIQUE (hackathon_id, sequence)
);
CREATE INDEX IF NOT EXISTS hq_reporting_periods_window_idx ON hq_reporting_periods (hackathon_id, starts_at, ends_at);

-- When a project entered reporting, and whether it is currently paused. A
-- self-service import writes this row in the import's own transaction; an
-- admin writes it for a manually tracked project that was never imported
-- (enabled_by_user_id then names them, and is NULL for an import). No missed
-- week is ever recorded before eligible_from, so a late joiner starts in the
-- period that is open when they arrive. paused_at stops FUTURE periods only:
-- outcomes already closed are history and are never removed by a pause.
CREATE TABLE IF NOT EXISTS hq_reporting_eligibility (
  project_id uuid PRIMARY KEY REFERENCES hq_projects(id) ON DELETE CASCADE,
  hackathon_id int NOT NULL REFERENCES hq_hackathons(id) ON DELETE CASCADE,
  eligible_from timestamptz NOT NULL DEFAULT now(),
  paused_at timestamptz,
  enabled_by_user_id uuid REFERENCES hq_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hq_reporting_eligibility_hackathon_idx ON hq_reporting_eligibility (hackathon_id) WHERE paused_at IS NULL;

-- A reporting entry: one team update or one Captain note, bound to the period
-- it counts for.
--
-- author_kind/author_id follow hq_audit_events.actor_kind/actor_id rather
-- than a foreign key, and for the same two reasons. An author may be a public
-- account (hq_builder_profiles.id, a text id) or an operator (hq_users.id, a
-- uuid), which no single foreign key can express; and the plan requires the
-- ORIGINAL author to be preserved even when an admin edits, which a
-- SET NULL on account deletion would quietly undo. lib/hq/authz-sql.ts
-- namespaces an operator author as "operator:<id>" on the way out, so a
-- member id can never be read back as matching an operator's.
--
-- submitted_at is the server's own clock at first save and never changes: it
-- is what "an entry submitted during the period" is measured against, and an
-- edit years later must not move it. version is the optimistic concurrency
-- token HQ and the Telegram bot both check. `late` marks an entry explicitly
-- added to a period that had already closed; it never changes that period's
-- recorded outcome. voided_at is admin moderation: entries are never hard
-- deleted through ordinary permissions, and a voided entry stops counting
-- toward completion without losing its revisions.
CREATE TABLE IF NOT EXISTS hq_reporting_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES hq_projects(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES hq_reporting_periods(id) ON DELETE CASCADE,
  author_kind text NOT NULL CONSTRAINT hq_reporting_entries_author_kind_check CHECK (author_kind IN ('member','operator')),
  author_id text NOT NULL,
  body text NOT NULL CONSTRAINT hq_reporting_entries_body_check CHECK (btrim(body) <> '' AND length(body) <= 4000),
  visibility text NOT NULL DEFAULT 'shared' CONSTRAINT hq_reporting_entries_visibility_check CHECK (visibility IN ('shared','sensitive')),
  source text NOT NULL DEFAULT 'hq' CONSTRAINT hq_reporting_entries_source_check CHECK (source IN ('hq','telegram')),
  version int NOT NULL DEFAULT 1 CONSTRAINT hq_reporting_entries_version_check CHECK (version > 0),
  late boolean NOT NULL DEFAULT false,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by_user_id uuid REFERENCES hq_users(id) ON DELETE SET NULL,
  void_reason text
);
-- The dashboard's grouped completion read and a project's own entry list.
CREATE INDEX IF NOT EXISTS hq_reporting_entries_period_idx ON hq_reporting_entries (period_id, project_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS hq_reporting_entries_project_idx ON hq_reporting_entries (project_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS hq_reporting_entries_author_idx ON hq_reporting_entries (author_kind, author_id);

-- One immutable row per version of an entry, version 1 being the content as
-- first submitted. Written in the same transaction as the insert or update it
-- records, so an entry's current version always has a revision and history can
-- never be missing a step. Nothing updates or deletes these rows through the
-- application; the plan's "prevent production hard deletion of revisions
-- through ordinary app permissions" is enforced by there being no writer
-- other than the append in lib/hq/reporting.ts. Retrieval is operators only
-- (canReadRevisionHistory), and (entry_id, version) is both the uniqueness
-- rule and the pagination key.
CREATE TABLE IF NOT EXISTS hq_reporting_entry_revisions (
  entry_id uuid NOT NULL REFERENCES hq_reporting_entries(id) ON DELETE CASCADE,
  version int NOT NULL CONSTRAINT hq_reporting_entry_revisions_version_check CHECK (version > 0),
  body text NOT NULL,
  visibility text NOT NULL CONSTRAINT hq_reporting_entry_revisions_visibility_check CHECK (visibility IN ('shared','sensitive')),
  editor_kind text NOT NULL CONSTRAINT hq_reporting_entry_revisions_editor_kind_check CHECK (editor_kind IN ('member','operator')),
  editor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, version)
);

-- What a closed period recorded for a project. `completed` is the factual
-- on-time outcome at close and is never rewritten: a late entry added
-- afterwards does not erase a missed week. An admin correction of a mistaken
-- outcome writes corrected_completed beside it with a reason, so the
-- effective answer is COALESCE(corrected_completed, completed) and the
-- original stays readable. captain_user_id is the Captain at close, NULL for
-- unassigned, carried as history the way author_id is and so deliberately
-- without a foreign key: reassigning or deleting that account later must not
-- change what this period recorded.
CREATE TABLE IF NOT EXISTS hq_reporting_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL REFERENCES hq_reporting_periods(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES hq_projects(id) ON DELETE CASCADE,
  completed boolean NOT NULL,
  basis text NOT NULL CONSTRAINT hq_reporting_outcomes_basis_check CHECK (basis IN ('entry','submission','none')),
  entry_id uuid REFERENCES hq_reporting_entries(id) ON DELETE SET NULL,
  captain_user_id text,
  closed_at timestamptz NOT NULL DEFAULT now(),
  corrected_completed boolean,
  corrected_at timestamptz,
  corrected_by_user_id uuid REFERENCES hq_users(id) ON DELETE SET NULL,
  correction_reason text,
  UNIQUE (period_id, project_id)
);
CREATE INDEX IF NOT EXISTS hq_reporting_outcomes_project_idx ON hq_reporting_outcomes (project_id);

-- ---------------------------------------------------------------------------
-- Phase 6: the two contacts the reporting dashboards show.
--
-- Both are one nullable column and both are opt-in. Neither is derived from a
-- login, a profile email or a Colosseum field: a contact only exists here
-- because the person whose contact it is typed it in and, by typing it in,
-- approved the audience named beside the field.
--
-- `hq_project_onboarding.team_contact` is the plan's "preferred team contact,
-- including a Telegram contact when available": set by the team lead on the
-- team page, read by the team's assigned Captain and by admins, never by
-- another team and never by a Captain who is not assigned. It lives on the
-- onboarding row rather than on hq_projects because it belongs to the
-- self-imported team, and a CRM-only project already has hq_projects.lead_*
-- for the operator's own contact.
--
-- `hq_builder_profiles.captain_contact` is the other direction: the contact a
-- Captain approves for the teams they are assigned to, shown on those teams'
-- pages ("the assigned Captain and their approved contact when available")
-- and in Admin. Account-global like the Captain grant itself, because a
-- Captain who wants to be reached differently per team would be a second
-- audience rule with no product behind it.
--
-- It shares a name, and nothing else, with `hq_partners.captain_contact`,
-- which is a partner organisation's own contact person and has never had
-- anything to do with project Captains (the plan's "The existing partner
-- fields captain_name and captain_contact are partner contacts. They are not
-- project Captain assignments"). Different table, different meaning, no join
-- between them: a query that means this one always says
-- `FROM hq_builder_profiles`.
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS team_contact text;
ALTER TABLE hq_builder_profiles ADD COLUMN IF NOT EXISTS captain_contact text;
