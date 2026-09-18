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
ALTER TABLE hq_project_members ADD COLUMN IF NOT EXISTS source_present boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS hq_roster_username_idx ON hq_project_members(project_id, lower(colosseum_username));
CREATE UNIQUE INDEX IF NOT EXISTS hq_roster_builder_idx ON hq_project_members(project_id, builder_user_id);

CREATE TABLE IF NOT EXISTS hq_team_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES hq_project_onboarding(project_id) ON DELETE CASCADE,
  member_id uuid REFERENCES hq_project_members(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES hq_builder_profiles(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz DEFAULT (now() + interval '2 days'),
  share_code text,
  consumed_by text REFERENCES hq_builder_profiles(id),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hq_invites_member_idx ON hq_team_invites(member_id);
-- A null member identifies a reusable project link. Existing seat links keep
-- their saved expiry and consumption state, so no old bearer gains access.
ALTER TABLE hq_team_invites ALTER COLUMN member_id DROP NOT NULL;
ALTER TABLE hq_team_invites ALTER COLUMN expires_at DROP NOT NULL;
-- Keep the legacy default during rolling deploys: older code omits expiry
-- for seat links. New reusable links explicitly insert NULL instead.
ALTER TABLE hq_team_invites ALTER COLUMN expires_at SET DEFAULT (now() + interval '2 days');
ALTER TABLE hq_team_invites ADD COLUMN IF NOT EXISTS share_code text;
CREATE INDEX IF NOT EXISTS hq_invites_project_idx ON hq_team_invites(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS hq_invites_shared_project_idx ON hq_team_invites(project_id) WHERE member_id IS NULL;

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
-- Raw source URLs remain untrusted. Never restore a rejected scheme,
-- credential-bearing URL or control character into the normalized fields.
UPDATE hq_project_onboarding SET category = raw->'project'->>'category' WHERE category IS NULL AND raw->'project'->>'category' IS NOT NULL;
UPDATE hq_project_onboarding SET twitter_handle = raw->'project'->>'twitterHandle' WHERE twitter_handle IS NULL AND raw->'project'->>'twitterHandle' IS NOT NULL;
UPDATE hq_project_onboarding SET website = raw->'project'->>'website' WHERE website IS NULL
  AND (raw->'project'->>'website') ~* '^https?://[^/@[:space:][:cntrl:]]+([/?#][^[:space:][:cntrl:]]*)?$' AND position(chr(92) in (raw->'project'->>'website')) = 0;
UPDATE hq_project_onboarding SET repo_link = raw->'project'->>'repoLink' WHERE repo_link IS NULL
  AND (raw->'project'->>'repoLink') ~* '^https?://[^/@[:space:][:cntrl:]]+([/?#][^[:space:][:cntrl:]]*)?$' AND position(chr(92) in (raw->'project'->>'repoLink')) = 0;
UPDATE hq_project_onboarding SET presentation_link = raw->'project'->>'presentationLink' WHERE presentation_link IS NULL
  AND (raw->'project'->>'presentationLink') ~* '^https?://[^/@[:space:][:cntrl:]]+([/?#][^[:space:][:cntrl:]]*)?$' AND position(chr(92) in (raw->'project'->>'presentationLink')) = 0;
UPDATE hq_project_onboarding SET technical_demo_link = raw->'project'->>'technicalDemoLink' WHERE technical_demo_link IS NULL
  AND (raw->'project'->>'technicalDemoLink') ~* '^https?://[^/@[:space:][:cntrl:]]+([/?#][^[:space:][:cntrl:]]*)?$' AND position(chr(92) in (raw->'project'->>'technicalDemoLink')) = 0;
UPDATE hq_project_onboarding SET pitch_video_link = raw->'project'->>'pitchVideoLink' WHERE pitch_video_link IS NULL
  AND (raw->'project'->>'pitchVideoLink') ~* '^https?://[^/@[:space:][:cntrl:]]+([/?#][^[:space:][:cntrl:]]*)?$' AND position(chr(92) in (raw->'project'->>'pitchVideoLink')) = 0;
UPDATE hq_project_onboarding SET demo_video_link = raw->'project'->>'demoVideoLink' WHERE demo_video_link IS NULL
  AND (raw->'project'->>'demoVideoLink') ~* '^https?://[^/@[:space:][:cntrl:]]+([/?#][^[:space:][:cntrl:]]*)?$' AND position(chr(92) in (raw->'project'->>'demoVideoLink')) = 0;
UPDATE hq_project_onboarding SET image_url = raw->'project'->'image'->>'url' WHERE image_url IS NULL
  AND (raw->'project'->'image'->>'url') ~* '^https?://[^/@[:space:][:cntrl:]]+([/?#][^[:space:][:cntrl:]]*)?$' AND position(chr(92) in (raw->'project'->'image'->>'url')) = 0;
UPDATE hq_project_onboarding SET external_hackathon_id = (raw->'project'->'hackathon'->>'id')::int
WHERE external_hackathon_id IS NULL
  AND CASE WHEN (raw->'project'->'hackathon'->>'id') ~ '^[0-9]{1,10}$'
    THEN (raw->'project'->'hackathon'->>'id')::bigint BETWEEN 1 AND 2147483647 ELSE false END;
-- The current public response supplies hackathonId directly on project.
UPDATE hq_project_onboarding SET external_hackathon_id = (raw->'project'->>'hackathonId')::int
WHERE external_hackathon_id IS NULL
  AND CASE WHEN (raw->'project'->>'hackathonId') ~ '^[0-9]{1,10}$'
    THEN (raw->'project'->>'hackathonId')::bigint BETWEEN 1 AND 2147483647 ELSE false END;
UPDATE hq_project_onboarding SET external_hackathon_slug = raw->'project'->'hackathon'->>'slug' WHERE external_hackathon_slug IS NULL AND raw->'project'->'hackathon'->>'slug' IS NOT NULL;
UPDATE hq_project_onboarding SET external_hackathon_name = raw->'project'->'hackathon'->>'name' WHERE external_hackathon_name IS NULL AND raw->'project'->'hackathon'->>'name' IS NOT NULL;
UPDATE hq_project_onboarding SET tracks = ARRAY(SELECT jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(raw->'project'->'tracks') = 'array' THEN raw->'project'->'tracks' ELSE '[]'::jsonb END))
WHERE tracks = '{}' AND jsonb_typeof(raw->'project'->'tracks') = 'array';
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

-- Whether this entry can complete the team's week, added 18 September 2026
-- with the Captains' Den redesign: "Captain notes never change a team's
-- update status." A week is the TEAM's to complete, so only an entry written
-- through team membership counts; a note from the assigned Captain or from an
-- operator, shared or sensitive, is recorded beside the week and never stands
-- in for the team's own update. Written once by createUpdate from the
-- authorization decision (`via`), never edited afterwards, and read by the
-- two completion queries (reportingStatus's tallies and closePeriod's first
-- entry). Rows from before the column are team members' and Captains' alike,
-- and the default keeps what those weeks already recorded.
ALTER TABLE hq_reporting_entries ADD COLUMN IF NOT EXISTS counts_toward_completion boolean NOT NULL DEFAULT true;

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

-- Whether the project was EXEMPT from this period rather than accountable for
-- it, added 15 September 2026 with the pause history above.
--
-- Closure used to skip a paused project entirely, writing no row at all. That
-- left nothing saying the week had been excused, so once the pause ended and
-- `paused_at` was cleared, the next status read looked at a closed week with
-- no outcome and counted it as accountable and missing: a pause that turned
-- into missed weeks the moment it was lifted. Recording the exemption at
-- close, beside the factual outcome, is what makes a closed week's answer
-- final — the same reasoning as `completed` itself never being rewritten.
--
-- `completed` and `basis` still record what actually happened in the week (a
-- paused team that wrote an update anyway did write one); `exempt` is the
-- separate statement that the week was not being counted against them.
ALTER TABLE hq_reporting_outcomes ADD COLUMN IF NOT EXISTS exempt boolean NOT NULL DEFAULT false;

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

-- ---------------------------------------------------------------------------
-- Pause history, added 15 September 2026 after the phase 0-6 review.
--
-- `hq_reporting_eligibility.paused_at` says whether a project is paused RIGHT
-- NOW, which is all a screen needs and all the status read used to have. It
-- cannot answer "was this project paused in the week that just closed?",
-- because resuming clears it: the pause's duration was lost, and the next
-- status read then counted every week of the exemption as accountable and
-- missing. A pause that quietly turns into missed weeks the moment it ends is
-- not a pause.
--
-- So the intervals are kept beside it, one row per pause, closed by the
-- resume that ended it. `accountable()` in lib/hq/reporting.ts reads these
-- rather than the single column: a period is exempt when some interval had
-- begun before the period's exclusive end and had not ended by it. For a
-- project paused right now that is exactly what the single column meant, so
-- nothing about live behaviour changes; what is new is that the exemption
-- survives the resume, and that repeated pauses each keep their own window.
--
-- The column stays as the current-state marker every reader already uses, and
-- the open interval (`resumed_at IS NULL`) is its history twin: the partial
-- unique index below is what keeps the two from drifting into two open pauses
-- for one project.
CREATE TABLE IF NOT EXISTS hq_reporting_pause_intervals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES hq_projects(id) ON DELETE CASCADE,
  hackathon_id int NOT NULL REFERENCES hq_hackathons(id) ON DELETE CASCADE,
  paused_at timestamptz NOT NULL,
  resumed_at timestamptz,
  paused_by_user_id uuid REFERENCES hq_users(id) ON DELETE SET NULL,
  resumed_by_user_id uuid REFERENCES hq_users(id) ON DELETE SET NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_reporting_pause_window_check CHECK (resumed_at IS NULL OR resumed_at >= paused_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS hq_reporting_pause_open_idx ON hq_reporting_pause_intervals (project_id) WHERE resumed_at IS NULL;
CREATE INDEX IF NOT EXISTS hq_reporting_pause_project_idx ON hq_reporting_pause_intervals (project_id, paused_at);

-- A database that was already carrying a live pause keeps it: the open
-- interval is opened at the pause's own instant, not at migration time, so
-- the weeks it already covered stay covered. Nothing can be reconstructed for
-- a pause that was already resumed before this table existed; those weeks
-- were already counted and are left exactly as they were recorded.
INSERT INTO hq_reporting_pause_intervals (project_id, hackathon_id, paused_at)
SELECT e.project_id, e.hackathon_id, e.paused_at FROM hq_reporting_eligibility e
WHERE e.paused_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM hq_reporting_pause_intervals i WHERE i.project_id = e.project_id AND i.resumed_at IS NULL);

-- ---------------------------------------------------------------------------
-- HQ project ownership, added 15 September 2026 after the phase 0-6 review.
--
-- The plan's Request help route (phase 3: "If an unsubmitted project cannot
-- yet be fetched, keep a Request help route usable ... so an admin can create
-- or link the HQ project by hand. Model HQ project ownership independently of
-- a successful external snapshot, backfilling existing owners from
-- onboarding") needs an owner that does not live on the Colosseum snapshot.
-- Until this table, `hq_project_onboarding.owner_user_id` was the only
-- ownership there was, and that row cannot exist without an `external_id`, so
-- a hand-created project could be given a Captain and weekly reporting while
-- its own builders had no way in at all.
--
-- One row per project, the account that owns it in HQ, and where that
-- ownership came from: `import` for a successful Colosseum import (backfilled
-- below, and written by `importTeam` from then on) and `admin` for a project
-- an operator created from a help request. `loadTeamMembership`
-- (lib/hq/authz-sql.ts) reads this table for the owner half of membership, so
-- the two sources are one rule rather than two.
--
-- Attaching a Colosseum snapshot later adds the onboarding row to THIS
-- project id and leaves this row alone, which is the plan's "later source
-- reconciliation attaches the real source ID without replacing the HQ project
-- or its history". No external id is ever invented to make that possible.
CREATE TABLE IF NOT EXISTS hq_project_ownership (
  project_id uuid PRIMARY KEY REFERENCES hq_projects(id) ON DELETE CASCADE,
  hackathon_id int NOT NULL REFERENCES hq_hackathons(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES hq_builder_profiles(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'import' CONSTRAINT hq_project_ownership_source_check CHECK (source IN ('import','admin')),
  created_by_user_id uuid REFERENCES hq_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hq_project_ownership_owner_idx ON hq_project_ownership (owner_user_id);

INSERT INTO hq_project_ownership (project_id, hackathon_id, owner_user_id, source, created_at)
SELECT o.project_id, o.hackathon_id, o.owner_user_id, 'import', o.created_at FROM hq_project_onboarding o
ON CONFLICT (project_id) DO NOTHING;

-- Which help request a hand-created project answers, so the admin screen can
-- show the request and the project it became together, and so a second press
-- cannot create a second project for the same request.
ALTER TABLE hq_project_import_requests ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES hq_projects(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hq_project_import_requests_project_idx ON hq_project_import_requests (project_id) WHERE project_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The STNL Telegram bot (phase 7).
--
-- The bot is an alternate interface to the SAME reporting service the website
-- writes through (lib/hq/reporting.ts). Nothing below stores a permission, a
-- completion rule or a copy of an update: an entry still lives in
-- hq_reporting_entries with `source = 'telegram'`, and that column is the only
-- difference between a save made here and one made on the website.
--
-- What these four tables hold is chat state, and chat state only: which
-- Telegram update has already been processed, which button press means what,
-- what someone has typed but not yet saved, and which message still has to go
-- out. All four are written only by lib/hq/telegram-bot-store.ts.

-- Which private chat the bot talks to this account in. It belongs beside the
-- messaging decision rather than beside the identity: a chat id exists only
-- because the person opened the bot, and it is worthless without the consent
-- row next to it. Phase 8 reads it to deliver the Wednesday reminder.
--
-- Nullable, because the consent row can be written from /hq/account before
-- the person has ever opened the chat. A NULL chat id is "connected, no chat
-- yet", which a sender treats exactly like consent withheld: there is nowhere
-- to send.
ALTER TABLE hq_telegram_bot_consent ADD COLUMN IF NOT EXISTS chat_id bigint;
-- WHICH verified Telegram identity opened the chat above. Written only by
-- `bindBotChat`, from the identity on the update it is handling, and cleared
-- whenever the connected identity changes. Without it, "the chat on this row"
-- and "the account connected to HQ right now" were two facts nothing
-- compared: disconnecting Telegram left the chat id in place, reconnecting a
-- DIFFERENT Telegram account rewrote telegram_user_id beside it, and a
-- reminder queued for the old account was delivered into the old account's
-- private chat. An external review reproduced that on 15 September 2026.
-- Clearing chat_id on both paths fixes the observed case; this column is what
-- makes the invariant checkable rather than dependent on every future writer
-- remembering to clear it.
ALTER TABLE hq_telegram_bot_consent ADD COLUMN IF NOT EXISTS chat_bound_telegram_user_id bigint;

-- Every Telegram update this deployment has accepted, by Telegram's own
-- update_id. Telegram retries a delivery it did not get a 200 for, so the
-- same update_id can arrive more than once; the PRIMARY KEY is what makes the
-- second arrival a no-op instead of a second saved entry.
--
-- Durable rather than process memory, per the plan: a serverless deployment
-- has no shared memory between invocations, so an in-process set would
-- deduplicate nothing in production.
--
-- `state` is the receipt's own lifecycle, not the update's meaning, and only
-- 'done' is terminal. A row is claimed as 'processing' under a LEASE; the
-- handler sets 'done' when it finished, or 'failed' when it did not. A
-- delivery that arrives while a live lease is held is left alone, because an
-- overlapping delivery is a duplicate rather than a reason to run the handler
-- twice. A row whose lease has expired, or which is recorded as 'failed', is
-- re-claimable: Telegram retries anything it did not get a 200 for, and a
-- receipt that treated a crashed attempt as a success would swallow the
-- retry and lose the person's action for good. `attempts` is what stops that
-- becoming a loop.
--
-- Re-claiming is only safe because the handler's own writes are atomic: the
-- callback consumption, the reporting write and the durable confirmation all
-- commit in ONE transaction (see lib/hq/telegram-bot.ts), so an interrupted
-- attempt leaves nothing behind to be repeated.
--
-- Nothing of the update's content is stored ("Do not retain full raw webhook
-- bodies as general-purpose logs").
CREATE TABLE IF NOT EXISTS hq_telegram_updates (
  update_id bigint PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'processing' CONSTRAINT hq_telegram_updates_state_check CHECK (state IN ('processing','done','failed')),
  attempts int NOT NULL DEFAULT 1,
  last_error text,
  completed_at timestamptz,
  lease_expires_at timestamptz
);
ALTER TABLE hq_telegram_updates ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS hq_telegram_updates_state_idx ON hq_telegram_updates (state, received_at);

-- What a button press means. Telegram's callback_data travels in the chat and
-- comes back from the client, so it can never be the instruction itself: the
-- keyboard carries an opaque id and the instruction lives here, bound to the
-- account and the chat it was built for ("Callback identifiers are opaque
-- server-side references bound to the user and operation").
--
-- `single_use` separates the two kinds. A navigation press (open a project,
-- page a list) is idempotent and stays usable until it expires, because an
-- inline keyboard remains in the chat history and people scroll back to it. A
-- press that WRITES (save, confirm the new week, confirm sharing a note) is
-- claimed exactly once by a conditional UPDATE, which is what stops a
-- double-tap or a Telegram retry that arrives under a new update_id from
-- creating two entries.
--
-- `project_id`, `period_id` and `entry_id` are plain uuids with no foreign
-- key, deliberately. These rows are transient chat state with an expiry, not
-- records of a team: every read re-authorizes against the live project, so a
-- row left pointing at a deleted project grants exactly nothing, and keeping
-- them out of hq_projects' dependency graph keeps a Delete team confirmation
-- about the team's own records rather than about someone's half-typed
-- message. Same reasoning as hq_reporting_entries.author_id having no key.
CREATE TABLE IF NOT EXISTS hq_telegram_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES hq_builder_profiles(id) ON DELETE CASCADE,
  chat_id bigint NOT NULL,
  kind text NOT NULL,
  project_id uuid,
  period_id uuid,
  entry_id uuid,
  expected_version int,
  page int NOT NULL DEFAULT 0,
  visibility text CONSTRAINT hq_telegram_actions_visibility_check CHECK (visibility IS NULL OR visibility IN ('shared','sensitive')),
  single_use boolean NOT NULL DEFAULT false,
  draft_id uuid,
  draft_revision int,
  cursor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_update_id bigint
);
-- Which draft generation the button was built from. A button that touches a
-- draft is worthless the moment that draft changes underneath it: an inline
-- keyboard stays in the chat forever, so Save on a preview from ten minutes
-- ago must not save whatever draft happens to exist now. `draft_id` pins the
-- composing session and `draft_revision` pins the state it was rendered
-- from, and the flow requires BOTH to match before it acts. Without this a
-- Save from a replaced preview saved a different team's text.
ALTER TABLE hq_telegram_actions ADD COLUMN IF NOT EXISTS draft_id uuid;
ALTER TABLE hq_telegram_actions ADD COLUMN IF NOT EXISTS draft_revision int;
-- The keyset cursor a Next button continues from, so a list pages through the
-- reporting service's own cursor rather than re-reading a capped set on every
-- press.
ALTER TABLE hq_telegram_actions ADD COLUMN IF NOT EXISTS cursor text;
-- Which edition this button is scoped to, or NULL for the account's default
-- one. The bot picks a single current edition for every read, which is right
-- for somebody who opened the menu themselves and wrong for a button that
-- came from a notification about a DIFFERENT edition: phase 8's reminder
-- names one hackathon's teams, and before this its Add update button opened
-- the default hackathon's instead. Every button minted during a press
-- inherits the edition of the button that was pressed, so paging and picking
-- a team stay inside the edition the message was about.
ALTER TABLE hq_telegram_actions ADD COLUMN IF NOT EXISTS hackathon_id int;
CREATE INDEX IF NOT EXISTS hq_telegram_actions_user_idx ON hq_telegram_actions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hq_telegram_actions_expiry_idx ON hq_telegram_actions (expires_at);
CREATE INDEX IF NOT EXISTS hq_telegram_actions_draft_idx ON hq_telegram_actions (draft_id) WHERE draft_id IS NOT NULL;

-- What someone has typed and not yet saved. One draft per account and chat,
-- so opening a second project replaces the first rather than leaving two
-- half-written updates racing for the same Save button.
--
-- The plan's required fields are all here and all explicit: project, period,
-- step, version and expiry. `period_id` is what binds the draft to its week,
-- so a save that crossed midnight is caught by the reporting service's own
-- `expectedPeriodId` check rather than silently landing in a different week;
-- `expected_version` does the same for an edit.
--
-- `body` is the one place a member's unsaved text lives outside
-- hq_reporting_entries, and it is transient by design: every row carries
-- `expires_at`, `purgeExpiredBotState` removes them, and nothing else reads
-- the column. Ids follow the no-foreign-key rule described above.
CREATE TABLE IF NOT EXISTS hq_telegram_drafts (
  user_id text NOT NULL REFERENCES hq_builder_profiles(id) ON DELETE CASCADE,
  chat_id bigint NOT NULL,
  -- The composing session, and the state it is in. One draft per chat means
  -- the primary key cannot identify WHICH draft a button meant, so these two
  -- do: `id` changes when a new compose replaces the old one, `revision`
  -- increments on every change to the draft. Every button that touches a
  -- draft records both, and the flow refuses unless both still match, which
  -- is what makes a Save from a replaced or re-rendered preview a no-op
  -- rather than a write against somebody else's text.
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  revision int NOT NULL DEFAULT 1,
  step text NOT NULL CONSTRAINT hq_telegram_drafts_step_check CHECK (step IN ('awaiting_text','preview')),
  project_id uuid NOT NULL,
  hackathon_id int NOT NULL,
  period_id uuid,
  entry_id uuid,
  expected_version int,
  visibility text NOT NULL DEFAULT 'shared' CONSTRAINT hq_telegram_drafts_visibility_check CHECK (visibility IN ('shared','sensitive')),
  body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, chat_id)
);
ALTER TABLE hq_telegram_drafts ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE hq_telegram_drafts ADD COLUMN IF NOT EXISTS revision int NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS hq_telegram_drafts_expiry_idx ON hq_telegram_drafts (expires_at);

-- The outgoing message queue, for the messages that must not be lost.
--
-- "Where needed", per the plan, and needed means exactly one thing: a message
-- whose loss would leave someone not knowing whether their write landed. The
-- save confirmation is queued inside the saving transaction, so it either
-- commits with the entry or does not exist. Menus, project lists and the
-- preview are sent directly and are never queued: they carry no news, and a
-- failed send is answered by pressing the button again.
--
-- That split is also the privacy rule. A preview repeats what someone typed,
-- a sensitive note included; a confirmation says which week is now Updated
-- and nothing else. Because only the second kind is queued, NO ENTRY BODY IS
-- EVER WRITTEN TO THIS TABLE, and tests/hq/telegram-bot.test.ts asserts it.
--
-- `dedupe_key` is what makes an at-least-once delivery attempt at-most-once
-- per event: the save confirmation keys on the entry and its version, and
-- phase 8's reminder will key on Captain, edition, period and type.
CREATE TABLE IF NOT EXISTS hq_telegram_outgoing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL,
  user_id text REFERENCES hq_builder_profiles(id) ON DELETE SET NULL,
  kind text NOT NULL,
  body text NOT NULL,
  reply_markup jsonb,
  dedupe_key text UNIQUE,
  state text NOT NULL DEFAULT 'queued' CONSTRAINT hq_telegram_outgoing_state_check CHECK (state IN ('queued','sent','failed','skipped')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  provider_message_id bigint,
  skip_reason text,
  -- Who this row is about, read again immediately before the send. A queued
  -- message is not a licence: between the enqueue and the drain somebody can
  -- turn bot messages off, unlink Telegram, start a new chat or lose the
  -- assignment the message names, and the sender has to notice all four.
  -- Phase 8's reminder needs exactly the same check, which is why it lives on
  -- the row rather than in the one caller that has it today.
  project_id uuid,
  hackathon_id int,
  -- The claim. A drain takes a bounded batch by setting these, sends outside
  -- the database transaction, and only the claim's owner may complete it, so
  -- two drains running at once cannot both send the same row. The claim
  -- expires, so a worker that dies mid-send releases its rows instead of
  -- stranding them.
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  claimed_by text,
  -- When this row may next be attempted. Telegram's own `retry_after` is
  -- written here rather than discarded, so a rate limit is respected instead
  -- of hammered.
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
ALTER TABLE hq_telegram_outgoing ADD COLUMN IF NOT EXISTS project_id uuid;
ALTER TABLE hq_telegram_outgoing ADD COLUMN IF NOT EXISTS hackathon_id int;
ALTER TABLE hq_telegram_outgoing ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE hq_telegram_outgoing ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;
ALTER TABLE hq_telegram_outgoing ADD COLUMN IF NOT EXISTS claimed_by text;
ALTER TABLE hq_telegram_outgoing ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
CREATE INDEX IF NOT EXISTS hq_telegram_outgoing_state_idx ON hq_telegram_outgoing (state, created_at);
CREATE INDEX IF NOT EXISTS hq_telegram_outgoing_claim_idx ON hq_telegram_outgoing (state, next_attempt_at, claim_expires_at) WHERE state = 'queued';

-- One reminder, per Captain, per edition, per reporting period, per reminder
-- type (phase 8). The unique key across those four columns is what makes an
-- at-least-once scheduler at-most-once per event: two overlapping job runs
-- both try to insert, one wins the index and the other finds the decision
-- already recorded, so a second message is never built.
--
-- The row is the DECISION, not the message. It is written in the same
-- transaction as the queued message it names (`outgoing_id`), so a reminder
-- that was recorded always has a message behind it and a message that was
-- queued always has a record in front of it. A reminder that is not sent is
-- recorded just as durably, with its reason: no Telegram identity, messaging
-- turned off, no private chat opened, the Captain capability revoked, or
-- nothing outstanding to remind them about. That is the plan's "record a
-- skipped delivery reason and show it in HQ", and it is why this table exists
-- rather than a query over hq_telegram_outgoing, which only ever holds
-- messages somebody decided to send.
--
-- NO PROJECT ID AND NO UPDATE TEXT. `project_count` is how many teams were
-- outstanding at the moment the message was built, which is what an admin
-- needs; naming the projects would put a pointer to hq_projects in a history
-- table and would make a deleted team's name outlive the team. The names live
-- in the message body on hq_telegram_outgoing, which is purged on its own
-- retention, and nowhere else.
--
-- `reminder_type` deliberately carries no CHECK constraint. Adding a value to
-- one later would mean a drop-and-add pair running on every future migration
-- (docs/hq/contracts.md, migration conventions), and the vocabulary is
-- already pinned in lib/hq/jobs.ts where the only writer reads it.
CREATE TABLE IF NOT EXISTS hq_reminder_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captain_user_id text NOT NULL REFERENCES hq_builder_profiles(id) ON DELETE CASCADE,
  hackathon_id int NOT NULL REFERENCES hq_hackathons(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES hq_reporting_periods(id) ON DELETE CASCADE,
  reminder_type text NOT NULL DEFAULT 'weekly_nudge',
  -- The period's own nudge instant, kept on the row so that an admin reading
  -- the history sees when it was due even after a schedule edit moved the
  -- period it belongs to.
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'queued' CONSTRAINT hq_reminder_deliveries_state_check CHECK (state IN ('queued','sent','skipped','failed')),
  reason text,
  project_count int NOT NULL DEFAULT 0,
  -- The queued message this decision produced, as a plain uuid with no
  -- foreign key: deliveries are kept far longer than the outgoing rows they
  -- point at, and a purge of the queue must not take the record of the
  -- reminder with it.
  outgoing_id uuid,
  provider_message_id bigint,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (captain_user_id, hackathon_id, period_id, reminder_type)
);
-- When the queue will try again, copied from the outgoing row so the record
-- stays readable after that row is purged on its own shorter retention. An
-- admin looking at a reminder that has not arrived needs to tell "nobody has
-- tried yet" from "Telegram asked us to wait a minute", and before this the
-- two looked identical.
ALTER TABLE hq_reminder_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
CREATE INDEX IF NOT EXISTS hq_reminder_deliveries_edition_idx ON hq_reminder_deliveries (hackathon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hq_reminder_deliveries_open_idx ON hq_reminder_deliveries (period_id) WHERE state = 'queued';

-- ---------------------------------------------------------------------------
-- Phase 10: the final, submission-focused period.
--
-- The window itself is already here: hq_reporting_config.final_period_start_date
-- merges the remaining weeks into one period whose mode is 'submission', and
-- official_submission_deadline is Colosseum's own cutoff when it differs from
-- HQ's window. What phase 10 adds is what that period needs beyond a week:
-- which materials the edition actually asks for, how often HQ may re-read
-- Colosseum on the teams' behalf, where the deadline came from, and a durable
-- record of the closing reconciliation.

-- Which submission materials this edition requires, and which are merely
-- offered. Anything named in NEITHER array is UNKNOWN, and a screen says so
-- rather than guessing: the plan is explicit that HQ must "distinguish
-- Required, Optional and Unknown requirement information" and must not
-- "hardcode every available API link field as mandatory".
--
-- Operator data, like the external edition mapping: an admin types it in
-- under Weekly reporting, it is never seeded and never a constant. Colosseum
-- does not publish per-field requirements on any endpoint HQ can read
-- (projectCompletion is owner-authenticated and absent from the public
-- detail response), so an edition nobody has configured reads back as all
-- Unknown, which is the honest answer rather than a fabricated checklist.
--
-- The keys are the material keys in lib/hq/submission-readiness.ts. An
-- unrecognised key is ignored on the way out rather than rejected here: the
-- array is configuration, and a stale key left behind by a renamed material
-- must not make the whole edition unreadable.
ALTER TABLE hq_reporting_config ADD COLUMN IF NOT EXISTS required_materials text[] NOT NULL DEFAULT '{}';
ALTER TABLE hq_reporting_config ADD COLUMN IF NOT EXISTS optional_materials text[] NOT NULL DEFAULT '{}';

-- How stale a project's Colosseum snapshot may get during the final period
-- before the scheduled job re-reads it, in minutes. NULL is off, and off is
-- the default: the plan allows bounded server-side refreshes "if configured"
-- and forbids polling "from every browser tab", so nothing here runs until an
-- admin asks for it. The floor is deliberate; a one-minute setting would be a
-- rate limit incident rather than a feature.
ALTER TABLE hq_reporting_config ADD COLUMN IF NOT EXISTS submission_refresh_minutes int CONSTRAINT hq_reporting_config_submission_refresh_check CHECK (submission_refresh_minutes IS NULL OR submission_refresh_minutes >= 15);

-- Where official_submission_deadline came from and when it was last read.
-- An admin may type it in, or press Read from Colosseum, which asks the
-- listing envelope's projectSubmissionEndDate for the configured external
-- edition. Both are the same column because both are the same fact; the
-- provenance is beside it so a screen can say which, and so a failed read
-- leaves the previous value and its own timestamp alone.
ALTER TABLE hq_reporting_config ADD COLUMN IF NOT EXISTS official_deadline_source text CONSTRAINT hq_reporting_config_deadline_source_check CHECK (official_deadline_source IS NULL OR official_deadline_source IN ('admin','colosseum'));
ALTER TABLE hq_reporting_config ADD COLUMN IF NOT EXISTS official_deadline_checked_at timestamptz;

-- Failed refreshes also consume an attempt. Scheduling only by the last
-- successful read lets a few unavailable projects monopolize every batch.
ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS source_attempted_at timestamptz;

-- The closing reconciliation of the submission period: one row per project
-- per submission period, written when that period closes and resolved when
-- authoritative evidence arrives.
--
-- It exists because the plan asks for two things a reporting outcome cannot
-- say at once. "If the API is unavailable, preserve Not checked/stale
-- information and flag reconciliation as pending internally; do not claim an
-- unverified submission failure" — so there has to be a place to record that
-- HQ has NOT established anything yet, separate from the week's factual
-- outcome, which is already recorded and is never rewritten. And "once
-- verified, use the official submitted timestamp and deadline to establish
-- whether it was on time, even if discovery happened later" — so the evidence
-- has to be kept with the deadline it was judged against, rather than
-- recomputed later against a deadline an admin has since edited.
--
-- What it is not: a second completion rule. The week's answer stays
-- COALESCE(corrected_completed, completed) on hq_reporting_outcomes. When
-- delayed evidence shows an on-time submission for a week recorded as missed,
-- the reconciliation calls correctOutcome, which writes the correction beside
-- the original with a mandatory reason and an audit event, and sets
-- outcome_corrected here so a re-run does not do it twice. A submission after
-- the deadline corrects nothing: it is recorded, it is marked not on time,
-- and the missed week stands.
CREATE TABLE IF NOT EXISTS hq_submission_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL REFERENCES hq_reporting_periods(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES hq_projects(id) ON DELETE CASCADE,
  hackathon_id int NOT NULL REFERENCES hq_hackathons(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CONSTRAINT hq_submission_reconciliations_state_check CHECK (state IN ('pending','resolved')),
  -- The evidence, as phase 3's interpretSubmission wrote it. NULL while
  -- nothing has been established: deliberately not 'not_checked', so that
  -- "we never got an answer" and "Colosseum answered, and the answer was
  -- not checked" cannot be confused for one another.
  submission_status text CONSTRAINT hq_submission_reconciliations_status_check CHECK (submission_status IS NULL OR submission_status IN ('not_checked','submitted','not_submitted')),
  submitted_at timestamptz,
  -- The deadline this evidence was judged against, copied when reconciliation opens.
  deadline timestamptz,
  on_time boolean,
  evidence_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  -- HQ's own error code from the last failed read, never Colosseum's words.
  last_error text,
  outcome_corrected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_id, project_id)
);
CREATE INDEX IF NOT EXISTS hq_submission_reconciliations_pending_idx ON hq_submission_reconciliations (hackathon_id, updated_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS hq_submission_reconciliations_project_idx ON hq_submission_reconciliations (project_id);
