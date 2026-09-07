-- Additive public HQ onboarding tables. Apply after schema.sql and upgrades.ts.
-- Public identities never reference hq_users, the operator authentication table.
CREATE TABLE IF NOT EXISTS hq_builder_profiles (
  id text PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  tier text NOT NULL DEFAULT 'regular' CHECK (tier IN ('regular', 'member')),
  created_at timestamptz NOT NULL DEFAULT now()
);

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
