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
  proof_comment_id bigint,
  proof_author_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hackathon_id, external_id)
);

ALTER TABLE hq_project_members ADD COLUMN IF NOT EXISTS colosseum_username text;
ALTER TABLE hq_project_members ADD COLUMN IF NOT EXISTS builder_user_id text REFERENCES hq_builder_profiles(id) ON DELETE SET NULL;
ALTER TABLE hq_project_members ADD COLUMN IF NOT EXISTS joined_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS hq_roster_username_idx ON hq_project_members(project_id, lower(colosseum_username));
CREATE UNIQUE INDEX IF NOT EXISTS hq_roster_builder_idx ON hq_project_members(project_id, builder_user_id);

CREATE TABLE IF NOT EXISTS hq_project_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES hq_builder_profiles(id) ON DELETE CASCADE,
  hackathon_id int NOT NULL REFERENCES hq_hackathons(id) ON DELETE CASCADE,
  project_url text NOT NULL,
  external_id int NOT NULL,
  claimed_username text NOT NULL,
  code text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS hq_challenges_user_idx ON hq_project_challenges(user_id, issued_at);

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
