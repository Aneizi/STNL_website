# HQ implementation log

One entry per phase of the Captains and Colosseum plan
(`docs/plans/2026-09-13-hq-captains-and-colosseum.md`). Every entry records:

1. What changed and which migrations apply.
2. Which acceptance checks passed and what remains blocked.
3. Any changed interface that later phases need to use.
4. Which external configuration is still required, by variable name only.

Never put a secret, a token, a connection string or any other value in this file.
Names only.

## Phase 0, establish the baseline and prove the integration choices

### Baseline

Measured on `main` at commit `bcba7df`, before any phase 0 change:

- `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`: 421 tests pass.
- `npx tsc --noEmit`: clean.
- `npm run lint`: 18 warnings, all pre-existing, all in
  `public/deck/deck-stage.js`. They are out of scope and are left as they are.

The two `env -u` flags matter. A `DATABASE_URL` exported in the shell can reach
an unmocked `getSql()` during a test run, so every verification command in this
plan unsets both `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.

### What changed, task T0.2

Fictional Colosseum fixtures, docs scaffolding, module contracts and the
companion asset path record.

- New `tests/hq/fixtures/colosseum/` with `directories.json`, `listing.json`,
  `detail.json`, `errors.json` and a `README.md`. The field names, types and
  nullability are the ones observed against the public Colosseum API on
  2026-09-13. Every project, roster, handle, display name, avatar URL and
  project id in them is invented.
- `detail.json` carries two top level entries. `submitted` is the observed happy
  path. `unsubmitted` models a draft (`submittedAt: null`,
  `projectCompletion.isComplete: false` with a non empty `fieldErrors`) and is a
  structural assumption, unverified against a live draft, labelled as such in the
  fixture `README.md`.
- `tests/colosseum-api.test.ts` now builds its responses from
  `detail.json`'s `submitted` entry, which also means the existing suite
  validates the fixture against `projectSchema` on every run. Assertions are
  unchanged in meaning.
- `tests/hq/builder-onboarding.test.ts` uses the same fictional project, slug,
  external id and handles as inline constants, because its `PROJECT` is a mapped
  `ImportedProject` rather than a raw response.
- New `docs/hq/implementation-log.md` (this file), `docs/hq/manual-setup.md` and
  `docs/hq/contracts.md`.

Migrations: none. T0.2 adds no SQL, no schema change and no runtime code. Nothing
under `lib/`, `app/`, `components/` or `scripts/` was touched, and no database
was contacted.

### Checks passed

- `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`: 421 tests pass, the
  same count as the baseline.
- `npx tsc --noEmit`: clean.
- `npm run lint`: the same 18 pre-existing warnings, nothing new.
- No real Colosseum project slug, external project id, username, display name or
  avatar URL remains anywhere under `tests/`.
- Acceptance item "Colosseum capabilities and limitations are explicitly
  recorded": met by `docs/hq/contracts.md` and
  `tests/hq/fixtures/colosseum/README.md`.
- Acceptance item "Later phases have named service boundaries and no dependency
  on real secrets in code": met by `docs/hq/contracts.md` (named modules and
  entry points) and `docs/hq/manual-setup.md` (variable names only).

### Blocked or deferred

- T0.1, the Telegram OIDC spike, is pending. The Telegram design is
  source-verified but not proven, and it gates phase 1 and every piece of
  Telegram UI.
- T0.3, the operator login regression anchor over `lib/hq/actions/auth.ts`, is
  pending.
- The World's Fair external Colosseum id and slug are unverified. External id 6
  is the finished Frontier edition. An edition with external id 7 exists but its
  project directory is disabled, so its name, slug and dates are not obtainable
  through the public API. The mapping stays unset until Colosseum enables it.
- Colosseum exposes no registered but unsubmitted projects, so ownership proof
  before submission is not possible through the API. The manual review path is
  the fallback. Nothing in phases 0 to 2 depends on this.
- `projectCompletion.fieldErrors` element type is unverified. Only an empty
  array was ever observed.
- No stub source files were created. The controller ruled that a stub route
  handler would be a live endpoint and that stub modules are unnecessary work.
  Phases 3 to 10 are named in `docs/hq/contracts.md` and nothing more. The typed
  hooks that authorization needs for phase 4 and phase 5 records live inside
  `lib/hq/authz.ts`, created in phase 1.
- Live email delivery, Telegram login and Telegram bot messaging cannot be
  checked by any automated test. They are owner checks, listed separately in
  `docs/hq/manual-setup.md`.

### Changed interfaces

None. T0.2 changed no exported type, function or module. The only consumer facing
change is the fixture location, `tests/hq/fixtures/colosseum/`, which later
phases should reuse instead of inlining response shapes.

### External configuration still required, names only

Still not configured: `RESEND_API_KEY`, `EMAIL_FROM`,
`TELEGRAM_LOGIN_CLIENT_ID`, `TELEGRAM_LOGIN_CLIENT_SECRET`,
`TELEGRAM_BOT_USERNAME`, and for phase 7 `TELEGRAM_BOT_TOKEN`.

State unknown from a read-only checkout, so treat as unconfirmed:
`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`.

To be removed once the legacy providers go (task T2.1): `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.

Not an environment variable: the Colosseum external edition id and slug. They
are typed into Admin, Builder onboarding, and stored in
`hq_hackathon_onboarding`. Never seed them and never hard code them.

See `docs/hq/manual-setup.md` for who checks what.

### What changed, task T0.1

The Telegram OIDC spike: the phase 0 gate that proves a Telegram login yields
a real HQ account without any email, against the installed Better Auth 1.7.2,
with no fabricated verified email, no global change to email verification, no
patch to `node_modules` and no second session system.

- New `lib/hq/telegram-provider.ts`: a repo-owned static `OAuthProvider` with
  id `telegram`. Issuer and endpoints are constants (the discovery document is
  never fetched, so provider registration performs no I/O). Authorization Code
  with PKCE S256, server-side state and nonce, scopes `openid profile` only
  (never `phone`), `client_secret_basic` plus `client_id` in the token request,
  and a server-side id_token check (RS256 against a lazily fetched JWKS,
  issuer, audience, expiry, ten minute maximum age, constant-time nonce
  equality). `options.disableIdTokenSignIn` closes the client id_token branch
  at the library level. Because Telegram returns no email, the provider
  returns Better Auth's own placeholder `<sub>@telegram.placeholder.invalid`
  with `emailVerified: false`. That address is the internal non-deliverable
  identifier the plan permits: it is never displayed, never mailed and never
  synced as a contact, and `isPlaceholderEmail()` recognises it.
- New `lib/hq/telegram-identity-plugin.ts`: registers the provider only when
  configured; `databaseHooks.account.create.before` refuses, inside the
  creation transaction, a Telegram identity another account already holds
  (`telegram_identity_conflict`, nothing committed, no session);
  `account.create.after` and `account.update.after` write the identity row
  after commit, idempotently; `account.delete.after` removes it;
  `user.update.before` refuses a placeholder outside the OAuth callback;
  before hooks refuse placeholder addresses on every OTP, verification, reset
  and change-email endpoint (`placeholder_email_not_allowed`) and refuse any
  client `idToken` on `/sign-in/social` and `/link-social`
  (`id_token_not_accepted`); rate limit 10 per minute on `/callback/telegram`.
  `RECENT_SESSION_MS` is exported for phase 2.
- New `lib/hq/identity.ts`: `TelegramIdentity`, `getTelegramIdentity`,
  `hasTelegramIdentity` and the row writers, through the builder store's pg
  pool. The Telegram user id is `bigint` in PostgreSQL and a string in code.
- `lib/hq/member-auth.ts`: `currentMember()` now admits an account when it
  has a verified real email or a Telegram identity row, and fails closed
  otherwise. `MemberSessionUser.email` is `string | null`, null for the
  placeholder. `account.accountLinking` trusts `telegram`, allows different
  emails and disables implicit linking. `user.validateUserInfo` refuses
  placeholder creation outside OAuth. `sendVerificationOTP` refuses to mail a
  placeholder as its last line of defence. The CRM sync database hook uses the
  same predicate and skips placeholder accounts.
- `lib/hq/member-auth-config.ts`: `MemberAuthAvailability.telegram`.
- `lib/hq/actions/builders.ts` and `app/hq/(member)/profile/actions.ts`:
  compile-level adaptation to the nullable email. Builder actions that write
  CRM rows refuse an account without an email with a clear message until
  T1.1 makes the store null-safe.
- `scripts/hq/reset-statements.ts`: the six `hq_auth_*` tables are KEEP.
- New `tests/hq/helpers/db.ts` (`applyMigrations` through the migrate.ts
  splitter) and `tests/hq/member-auth-telegram.test.ts`; additions to
  `tests/hq/member-auth.test.ts`, `tests/hq/member-auth-config.test.ts` and
  `tests/hq/reset.test.ts`.

Migrations: one statement appended to `scripts/hq/member-auth-schema.sql`:
`CREATE TABLE IF NOT EXISTS hq_auth_telegram_identity (user_id text PRIMARY
KEY REFERENCES hq_auth_user(id) ON DELETE CASCADE, provider_subject text NOT
NULL UNIQUE, telegram_user_id bigint NOT NULL UNIQUE, username text, photo_url
text, linked_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz
NOT NULL DEFAULT now())`. Idempotent, applied by `hq:migrate` in the usual
order. Nothing in `scripts/hq/upgrades.ts`.

### Checks passed, task T0.1

- `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`: 433 tests pass
  (421 at the baseline, 12 new).
- `npx tsc --noEmit`: clean.
- `npm run lint`: the same 18 pre-existing warnings, nothing new.
- Gate: `tests/hq/member-auth-telegram.test.ts` applies all SQL through the
  splitter twice, stubs only `fetch`, Resend and the Next.js request helpers,
  and asserts spike steps 1 to 9: the authorization request, the token
  exchange (`Authorization: Basic`, `grant_type`, `redirect_uri`,
  `client_id`, `code_verifier` matching the captured `code_challenge`), the
  placeholder user, the account row, the identity row with the bigint id
  round-tripping as a string, `currentMember()` returning `email: null` and
  `requireMember()` resolving, fail-closed when the identity row is missing,
  replay and forged tokens refused, a returning login resolving to the same
  account, both id_token fences each sufficient on their own, placeholder
  guards, the conflict refused inside the transaction with nothing committed,
  and email sign-in plus existing sessions unaffected while Telegram is
  unreachable. Any request to the discovery document fails the suite.
- Acceptance "The Telegram identity strategy supports a real account without
  requiring an email afterward": met.

### Blocked or deferred, task T0.1

- CRM sync is skipped for an account whose email is null, and the builder
  actions refuse such an account, until T1.1 makes `hq_builder_profiles.email`
  nullable and the store null-safe. Marked `TODO(T1.1)` in code.
- Recency rule on link, unlink and change-email, the last-login-method rule,
  the link confirmation intent, `changeEmail` in the email OTP plugin and every
  piece of UI: T2.2 and T2.3. Google and GitHub stay until T2.1.
- Live only: the token exchange against the real endpoint, the signing
  algorithm staying RS256, and the Allowed URLs in BotFather. See
  `docs/hq/manual-setup.md`.

### Changed interfaces, task T0.1

`telegramProvider(env)`, `isPlaceholderEmail(email)`, `TelegramIdTokenClaims`,
`readTelegramClaims(idToken)` and the endpoint constants in
`lib/hq/telegram-provider.ts`; `hqTelegramIdentity({ provider })` and
`RECENT_SESSION_MS` in `lib/hq/telegram-identity-plugin.ts`;
`TelegramIdentity`, `getTelegramIdentity(userId)`, `hasTelegramIdentity(userId)`
in `lib/hq/identity.ts`; `MemberAuthAvailability.telegram`;
`MemberSessionUser.email: string | null`; `builderDatabase()` exported from
`lib/hq/builder-store.ts`; `applyMigrations(pg)` and friends in
`tests/hq/helpers/db.ts`.

### External configuration still required, task T0.1

`TELEGRAM_LOGIN_CLIENT_ID` and `TELEGRAM_LOGIN_CLIENT_SECRET` gate
availability; `TELEGRAM_BOT_USERNAME` is UI copy for T2.2. The redirect URL
to register in BotFather is `<BETTER_AUTH_URL>/api/auth/callback/telegram`.

### What changed, task T0.3

New `tests/hq/operator-auth-actions.test.ts`, 14 regression checks that call the
real `login`, `changePassword` and `logout` Server Actions in
`lib/hq/actions/auth.ts` against PGlite through `lib/hq/db.ts`'s own local
adapter: cookie name and flags plus the `hq_sessions` row on success, the
`/hq/select` and `/hq/change-password` redirects, username normalisation,
generic failure and the `hq_login_attempts` audit row, malformed input stopping
before the limiter, both `hq_login_limits` caps with the window reopening and
the success credit, `password_version` and row deletion each invalidating an
already issued token, logout revoking the row and clearing the cookie, and a
public `stnl_builder.*` member cookie refused by `currentUser()`. Tests only: no
migration, and nothing under `lib/`, `app/`, `components/` or `scripts/` was
touched. `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`: 449 tests pass
(435 before), `npx tsc --noEmit` clean, `npm run lint` unchanged at the same 18
pre-existing warnings.

## Phase 1, identity, authorization and the Captain capability

Not started.

## Phase 2, sign-in, linking and the member shell

Not started.
