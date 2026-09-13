-- Additive public-account tables for Better Auth 1.7.2.
-- These are deliberately separate from the operator-only hq_users/hq_sessions.
CREATE TABLE IF NOT EXISTS hq_auth_user (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hq_auth_session (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES hq_auth_user(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hq_auth_session_user_idx ON hq_auth_session("userId");

CREATE TABLE IF NOT EXISTS hq_auth_account (
  id text PRIMARY KEY,
  issuer text NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES hq_auth_user(id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, "accountId")
);
CREATE INDEX IF NOT EXISTS hq_auth_account_user_idx ON hq_auth_account("userId");
-- One Telegram account row per HQ user, whatever two in-flight link callbacks do.
CREATE UNIQUE INDEX IF NOT EXISTS hq_auth_account_telegram_user_idx ON hq_auth_account("userId") WHERE "providerId" = 'telegram';

CREATE TABLE IF NOT EXISTS hq_auth_verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hq_auth_verification_identifier_idx ON hq_auth_verification(identifier);

CREATE TABLE IF NOT EXISTS hq_auth_rate_limit (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  "lastRequest" bigint NOT NULL
);

-- Verified Telegram identity per public account. One row per account and one
-- account per Telegram user. provider_subject is the id_token `sub` and equals
-- hq_auth_account."accountId" for providerId 'telegram'. telegram_user_id is
-- the numeric Telegram user id (at most 52 significant bits, hence bigint,
-- exposed as a string at JSON boundaries). Written by the identity plugin's
-- database hooks after the Better Auth transaction commits.
CREATE TABLE IF NOT EXISTS hq_auth_telegram_identity (
  user_id text PRIMARY KEY REFERENCES hq_auth_user(id) ON DELETE CASCADE,
  provider_subject text NOT NULL UNIQUE,
  telegram_user_id bigint NOT NULL UNIQUE,
  username text,
  photo_url text,
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);
