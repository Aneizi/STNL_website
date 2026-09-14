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

### Phase 0 summary and acceptance checklist

Tasks T0.1, T0.2 and T0.3, closed out in task T2.6.

**What changed and which migrations apply.** The Telegram OIDC spike proved a
real HQ account without an email against the installed Better Auth 1.7.2
(`lib/hq/telegram-provider.ts`, `lib/hq/telegram-identity-plugin.ts`,
`lib/hq/identity.ts`, the nullable `MemberSessionUser.email`). Fictional
Colosseum fixtures, the three documents in `docs/hq/` and the module contracts
were written. The operator login regression anchor
(`tests/hq/operator-auth-actions.test.ts`) was added. One migration, in
`scripts/hq/member-auth-schema.sql`: `CREATE TABLE IF NOT EXISTS
hq_auth_telegram_identity`. Nothing in `scripts/hq/upgrades.ts`.

**Acceptance checklist.** The plan's phase 0 acceptance list, each item with the
test that proves it or the document that records it.

1. "Existing auth/import tests have a recorded baseline." Met by the Baseline
   section above, measured on `main` at `bcba7df`: 421 tests pass, `tsc` clean,
   18 pre-existing lint warnings in `public/deck/deck-stage.js`. A recorded
   measurement, not a test.
2. "The Telegram identity strategy supports a real account without requiring an
   email afterward." Passed, `tests/hq/member-auth-telegram.test.ts`: "completes
   the callback into a verified HQ account that has no email", "signs a
   returning Telegram user into the same account" and "never mails, looks up or
   verifies a placeholder address".
3. "Existing admin username/password login is covered by regression checks. No
   public-account migration work is introduced." Passed,
   `tests/hq/operator-auth-actions.test.ts`, 14 checks over the real `login`,
   `changePassword` and `logout` Server Actions, including "signs a known
   operator in, issues the session cookie and lands on the picker", "bumps
   password_version, revokes every live session and re-issues one" and "does not
   accept a live public member cookie as an operator session". The second
   sentence is a negative: no public-account migration route exists in the
   checkout, and none was added in phases 0 to 2.
4. "Colosseum capabilities and limitations are explicitly recorded." Met by
   `docs/hq/contracts.md` ("Colosseum integration, what the API can and cannot
   do") and `tests/hq/fixtures/colosseum/README.md`. The fixture is validated
   against `projectSchema` on every run through `tests/colosseum-api.test.ts`,
   whose "requires the correct hackathon ID and slug" pins the edition check.
5. "Later phases have named service boundaries and no dependency on real secrets
   in code." Met by the module map in `docs/hq/contracts.md` and by
   `docs/hq/manual-setup.md` carrying variable names only. A documentation rule,
   not a test.

**Gate.** "Do not proceed with a Telegram login UI that only works by pretending
Telegram verified an email." Passed before phase 1 began: the placeholder
address is an internal non-deliverable identifier with `emailVerified: false`,
it is never displayed, mailed or synced as a contact, and every mailing,
lookup and verification endpoint refuses it.

**Blocked or deferred out of phase 0, with the phase that owns each.**

- The World's Fair external Colosseum id and slug are unverified. Owner input,
  entered in Admin; phase 3 consumes it. See `docs/hq/manual-setup.md`.
- Colosseum exposes no registered but unsubmitted projects, so ownership proof
  before submission is not possible through the API. The manual review path is
  the fallback; phase 3 owns it.
- `projectCompletion.fieldErrors` element type is unverified. Phase 3.
- Live email delivery, Telegram login and Telegram bot messaging cannot be
  proven by any automated test. Owner checks, listed in
  `docs/hq/manual-setup.md`; bot delivery itself is phase 7.
- No stub source files were created. Phases 3 to 10 are named in
  `docs/hq/contracts.md` and nowhere else.

**Changed interfaces and external configuration.** See "Changed interfaces, task
T0.1" and "External configuration still required, task T0.1" above. Phases 1 and
2 added nothing to the variable list; the consolidated list is in the phase 2
summary at the end of this file.

## Phase 1, identity, authorization and the Captain capability

### What changed, task T1.1

Identity and CRM identity schema, a null-safe account sync and the
migration-order test. A public account is now one stable id whatever it signed
in with: an account without an email syncs, enrols and gets its People card
like any other, and every account has one CRM person that People cards in
every edition point at.

- `scripts/hq/builder-schema.sql`: `hq_builder_profiles.email` is nullable and
  `contact_email` is a new optional, self-declared column that is never filled
  from the login address, never a placeholder and never a login identity. New
  table `hq_crm_persons` (stable person id, display name, provisional
  normalized Colosseum username, at most one linked account). New nullable
  `person_id` on `hq_people` and `hq_project_members`, one card per person per
  edition. Two backfill statements give every existing account a person and
  stamp its cards. Every statement is a single idempotent statement; nothing
  was added to `scripts/hq/upgrades.ts`.
- New `lib/hq/crm-identity.ts`: `normalizeColosseumUsername`,
  `ensurePersonForAccount` (find by account, else create),
  `ensurePersonForRosterMember` (find by normalized username, else create;
  the display name is never a key), `linkPersonToAccount` (stamps the
  account's cards and links the person in one transaction; refuses to
  re-point a person or an account that is already linked elsewhere). Each
  takes the query handle it writes through, so inside a
  `BuilderDatabase.transaction` callback it commits or rolls back with the
  caller; the link also accepts the database itself and then opens its own
  transaction.
- `lib/hq/builder-store.ts`: `syncAccount` and `enroll` are null-safe. The
  profile email and the People card contact come only from a real login
  email; a placeholder given to the store is stored as null, and a card
  without a contact is the normal state for a Telegram-only account.
  `syncAccount` guarantees the account's person and `enroll` stamps
  `hq_people.person_id` on insert, or on a card that has none yet; the role
  behaviour on conflict is unchanged and `contact_email` is never written by a
  sync. New `profile(userId)` reader. `BuilderError` now lives in
  `lib/hq/builder-types.ts` and is re-exported unchanged.
- `lib/hq/builder-types.ts`: `BuilderIdentity = { id, email: string | null,
  name }` is what the store writes from; `BuilderUser` adds
  `contactEmail: string | null` and is what `profile()` reads.
- `lib/hq/identity.ts`: `getLoginMethods(userId)` returns the login email
  (null when the stored address is the placeholder), the Telegram identity and
  the contact email.
- `lib/hq/member-auth.ts`, `lib/hq/actions/builders.ts`,
  `app/hq/(member)/profile/actions.ts`: the four `TODO(T1.1)` skips and
  refusals are gone. `currentMember()`, the user-create hook, the profile
  action and every builder action sync and enrol an account without an email.
  Auto-enrolment on read is unchanged.
- `lib/hq/builder-admin-queries.ts`: `email` and `ownerEmail` are
  `string | null`. Display of a missing email is task T1.4.
- `scripts/hq/reset-statements.ts`: `hq_crm_persons` is KEEP. The eight
  builder tables that T0.1's reset test had left out of the manifest are
  classified so that a live reset does exactly what it did before:
  `hq_project_onboarding` and `hq_team_invites`, which the cascade from
  `hq_projects` already emptied, are CLEAR; `hq_builder_profiles`,
  `hq_hackathon_onboarding`, `hq_builder_enrollments`, `hq_project_challenges`,
  `hq_project_import_requests` and `hq_event_host_requests`, which the reset
  never touched, are KEEP. Whether enrolments, challenges and requests should
  be emptied with an edition's CRM is an open product ruling; moving a name
  between the two lists is the whole change.
- `vitest.config.mts`: `env` blanks `DATABASE_URL` and
  `DATABASE_URL_UNPOOLED` for every test. No test reads either for an opt-in
  real-Postgres run; the three that need a value stub it with `vi.stubEnv`.
- New `tests/hq/migration-order.test.ts`; additions to
  `tests/hq/builder-onboarding.test.ts`, `tests/hq/member-auth.test.ts`,
  `tests/hq/member-auth-telegram.test.ts` and `tests/hq/reset.test.ts`.

Migrations, all in `scripts/hq/builder-schema.sql`, applied by `hq:migrate` in
the usual order, one statement per call:

```sql
ALTER TABLE hq_builder_profiles ALTER COLUMN email DROP NOT NULL;
ALTER TABLE hq_builder_profiles ADD COLUMN IF NOT EXISTS contact_email text;
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
INSERT INTO hq_crm_persons (display_name, builder_user_id) SELECT p.name, p.id FROM hq_builder_profiles p WHERE NOT EXISTS (SELECT 1 FROM hq_crm_persons c WHERE c.builder_user_id = p.id);
UPDATE hq_people SET person_id = c.id FROM hq_crm_persons c WHERE hq_people.person_id IS NULL AND hq_people.builder_user_id IS NOT NULL AND c.builder_user_id = hq_people.builder_user_id;
```

The `CREATE TABLE IF NOT EXISTS hq_builder_profiles` definition matches, so a
fresh database gets the same shape without the two `ALTER` statements doing
anything.

### Checks passed, task T1.1

- `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`: 462 tests pass
  (449 before, 13 new).
- `npx tsc --noEmit`: clean.
- `npm run lint`: the same 18 pre-existing warnings, nothing new.
- Phase 1 gate, "additive migrations apply twice, on a fresh and on a
  populated database, through the statement splitter":
  `tests/hq/migration-order.test.ts` applies all three SQL files plus
  `applyUpgrades()` through the `migrate.ts` splitter twice on a fresh PGlite
  and compares every `hq_` column and index between the runs, and three times
  over a database that started from `tests/hq/fixtures/schema-pre-hackathon.sql`
  with operator logins, a hand-entered person and account-backed People cards
  inserted before the second run. It also checks that no statement carries a
  `$$` body or a second statement on the same line.
- Phase 1 gate, "existing `hq_users` ids, credentials and People links survive
  the migration": the same test asserts `hq_users` ids, usernames, password
  hashes and versions and `hq_people.builder_user_id` links are unchanged,
  that every linked card got the person of its own account, and that a
  hand-entered person got none.
- Every `hq_%` table that the migration creates is classified in
  `scripts/hq/reset-statements.ts`, and nothing is classified that does not
  exist. `tests/hq/reset.test.ts` now creates the builder tables through the
  splitter and seeds a row in each, so nothing is kept vacuously.
- Phase 1 gate, "link plus identity are written atomically":
  `tests/hq/builder-onboarding.test.ts` makes the second statement of
  `linkPersonToAccount` fail with a check constraint and asserts that the
  `hq_people.person_id` stamp written before it is rolled back.
- A Telegram-only account (`email: null`) syncs a profile with a null email, a
  People card with an empty contact and a person; the placeholder address is
  never stored in `email`, `contact_email` or `hq_people.contact`, even when
  handed to the store directly; the contact email survives a login email
  change and is never filled from it; a roster person is reused for the same
  normalized username and never for the same display name; a link is never
  re-pointed in either direction.
- `currentMember()` and the spike test now see the Telegram-only account
  synced with `email: null`; `getLoginMethods` reports the three parts
  separately, including an unverified real address as an unverified login
  method and never as a contact.

### Blocked or deferred, task T1.1

- The reset classification of `hq_builder_enrollments`,
  `hq_project_challenges`, `hq_project_import_requests` and
  `hq_event_host_requests` preserves the pre-T1.1 behaviour (untouched) and
  awaits a product ruling.
- The explicit correction path, `correctPersonMatch`, is task T1.2. Roster
  persons are created only by callers of `ensurePersonForRosterMember`; the
  import flow starts doing so in phase 3.
- A person's `display_name` is set when the person is created and not
  refreshed by later syncs, in line with People cards keeping an operator's
  edits. Renames are a later decision.
- No UI: the contact email has no form yet (phase 2), and the Admin
  "HQ accounts" list renders a missing email as nothing until task T1.4.

### Changed interfaces, task T1.1

`normalizeColosseumUsername(raw)`, `ensurePersonForAccount(db, { userId,
displayName })`, `ensurePersonForRosterMember(db, { colosseumUsername,
displayName })`, `linkPersonToAccount(db, { personId, userId })` in
`lib/hq/crm-identity.ts`; `getLoginMethods(userId)` and `LoginMethods` in
`lib/hq/identity.ts`; `BuilderIdentity`, `BuilderUser.email: string | null`,
`BuilderUser.contactEmail` and `BuilderError` in `lib/hq/builder-types.ts`
(`BuilderError` still importable from `lib/hq/builder-store.ts`);
`BuilderStore.profile(userId)`; `syncBuilderAccount(user: BuilderIdentity)`;
`BuilderAccount.email`, `BuilderHostRequest.email`,
`BuilderImportRequest.email` and `BuilderProjectReview.ownerEmail` are
`string | null`. Tables and columns: `hq_crm_persons`, `hq_people.person_id`,
`hq_project_members.person_id`, `hq_builder_profiles.contact_email`.
`isPlaceholderEmail`, `hasTelegramIdentity`, `getTelegramIdentity`,
`TelegramIdentity`, `MemberSessionUser` and `applyMigrations` are unchanged.

### External configuration still required, task T1.1

None added. The list from task T0.1 stands.

### What changed, task T1.2

Capability grants, the append-only audit trail, the Captain tag in People
and the explicit person-match correction. Captain is an admin-controlled
account capability: granted and revoked in Admin with a reason, shown in
People as a locked tag, never derived from a People role, a tag edit or the
membership tier, and opening no project on its own (assignment is phase 4).

- `scripts/hq/builder-schema.sql`: new `hq_account_capabilities` (one
  active grant per account and capability, revoked grants kept as history,
  the granting and revoking operator recorded) and `hq_audit_events`
  (append-only, `bigserial` id, structural `metadata`, never a note body).
  The T1.1 person backfill skips a card whose edition already carries the
  person, so a re-run of `hq:migrate` can never trip
  `hq_people_person_idx`. No `--` comment in `builder-schema.sql` contains a
  `;` any more (the splitter would not split on one mid-line, but the file
  now matches the rule it documents). The `capability` CHECK is named
  `hq_account_capabilities_capability_check`, so a later capability is a
  `DROP CONSTRAINT IF EXISTS` plus `ADD CONSTRAINT`.
- `scripts/hq/seed.ts` and `scripts/hq/upgrades.ts` (ruling Q4): the seeded
  partner-liaison People role is "Partner captain" ("Partner captains" as
  the filter label). One guarded, idempotent upgrade step renames it in
  place on a populated database, same id, so every card keeps its role.
- `scripts/hq/reset-statements.ts` (ruling Q10): both new tables are KEEP.
- New `lib/hq/capabilities.ts`: `Capability = "captain"`,
  `grantCapability`, `revokeCapability` (idempotent; the only writers of
  the table; the audit event is written in the same transaction and a test
  makes it fail to prove the grant rolls back with it),
  `listActiveCapabilities`, `listActiveCapabilitiesForUsers` (one query for
  a whole list), `listCapabilityGrants`, `personTags`. Reads take no cache.
- New `lib/hq/audit.ts` and pure `lib/hq/audit-sql.ts`: `recordAuditEvent`,
  `listAuditEvents` (keyset paged, filtered by kind, subject, edition or
  project), the `AUDIT_EVENT_KINDS` union. No update, no delete; a test
  asserts the exported names.
- New `lib/hq/actions/capabilities.ts`: `grantCaptainCapability(userId,
  reason)` and `revokeCaptainCapability(userId, reason)`, operator gated by
  `requireUser()`, actor id from the session only.
- `lib/hq/crm-identity.ts`: `correctPersonMatch(db, { personId, toUserId,
  reason, actor })`. Detaching (`toUserId: null`) unlinks the person, drops
  it from the old account's cards and gives that account a fresh person of
  its own. Attaching links the person when the account has none, and
  otherwise merges it into the account's own person: People cards and
  roster rows are re-pointed, a card whose edition already holds a card for
  the survivor is left unlinked and reported, the provisional Colosseum
  username moves to the survivor when it has none, the merged person is
  deleted and `person.match_corrected` is recorded, all in one transaction.
  Never by display name. `linkPersonToAccount`'s card stamp now skips a
  colliding card instead of failing.
- `lib/hq/actions/people.ts`: the operator action
  `correctPersonMatch({ personId, toUserId, reason })` over it.
- `lib/hq/queries.ts` and `lib/hq/types.ts`: `getPeople` returns
  `builderUserId`, `personId` and `tags: PersonTag[]` (the editable role
  tag first, then one protected tag per active capability, read in one
  batched query through `operatorQuery()`). `roleId` and `tier` are
  unchanged.
- `lib/hq/builder-admin-queries.ts`: `BuilderAccount.captain` and the
  `captains` list (`ActiveCaptain`, account-global).
- `components/hq/people.tsx`: renders the tags; the Captain tag has a lock
  and the hint "Granted in Admin" and is not editable; the role editor is
  unchanged; "Wrong match?" on an account-linked card clears the link with
  a reason. `components/hq/builder-admin.tsx`: active Captains, and grant
  or revoke per account with a reason and a confirmation.
- New `lib/hq/builder-db.ts` holds the builder-side pool and handle types,
  re-exported from `builder-store.ts`, so identity, audit and capability
  modules take the pool without an import cycle. `atomically()` moved
  there from `crm-identity.ts`.
- `tests/hq/helpers/db.ts`: `pgliteBuilderDatabase(pg)`, the serialized
  PGlite adapter the onboarding test used to carry privately.
- New `tests/hq/capabilities.test.ts`; additions to
  `tests/hq/builders-admin.test.ts`, `tests/hq/builder-onboarding.test.ts`,
  `tests/hq/migration-order.test.ts` and `tests/hq/reset.test.ts`.

Migrations, all in `scripts/hq/builder-schema.sql` plus one guarded step in
`scripts/hq/upgrades.ts`, applied by `hq:migrate` in the usual order:

```sql
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
```

The T1.1 backfill now reads `UPDATE hq_people SET person_id = c.id FROM
hq_crm_persons c WHERE ... AND NOT EXISTS (SELECT 1 FROM hq_people q WHERE
q.hackathon_id = hq_people.hackathon_id AND q.person_id = c.id)`. The
upgrade step is `UPDATE hq_people_roles SET label = 'Partner captain',
filter_label = 'Partner captains' WHERE label = 'Captain' AND NOT EXISTS
(SELECT 1 FROM hq_people_roles WHERE label = 'Partner captain')`, guarded
by `to_regclass('hq_people_roles')`.

### Checks passed, task T1.2

- `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`: 491 tests pass
  (462 before, 29 new).
- `npx tsc --noEmit`: clean.
- `npm run lint`: the same 18 pre-existing warnings, nothing new.
- Phase 1 gate, "editing a People role or tag cannot grant `captain`":
  `tests/hq/builders-admin.test.ts` edits a card to the "Partner captain"
  role, creates a person with it and changes a tier, and asserts no
  `hq_account_capabilities` row, no audit event and no protected tag.
- Phase 1 gate, "grant plus audit are written atomically":
  `tests/hq/capabilities.test.ts` makes the audit insert fail with a check
  constraint and asserts no grant row, and the same for a revocation; a
  failing later statement in the caller's transaction takes the grant with
  it. `tests/hq/builder-onboarding.test.ts` does the same for a person-match
  correction.
- Phase 1 gate, "a revocation is visible on the next request":
  `listActiveCapabilities`, `getPeople` and the Admin account list all read
  the revoked state on the very next call.
- Phase 1 gate, "additive migrations apply twice, on a fresh and on a
  populated database": the migration test now also creates
  `hq_builder_profiles` in its pre-T1.1 shape, seeds the old "Captain" role
  with a card, and runs a fourth pass over a card the unguarded backfill
  would have failed on.
- Acceptance "a Captain capability grants no project access without
  assignment": nothing in this task reads a capability to open anything;
  the authorization helpers are task T1.3.
- The audit module exports exactly `recordAuditEvent` and
  `listAuditEvents`, the statement builders contain no `UPDATE` or
  `DELETE`, and the `person.match_corrected` metadata carries ids, a reason
  and counts only.

### Blocked or deferred, task T1.2

- A revocation's reason is on its `capability.revoked` event; the grant row
  keeps the reason it was granted for, because the table has one `reason`
  column by design.
- `enroll()` was guarded in the task's fix round, so this bullet is closed,
  not deferred. The earlier text said `enroll()` was unchanged (ruling Q5)
  and still assumed that no other card in the edition carried the account's
  person. A person-match clear can leave exactly that state (a roster card
  keeps the person while the account's own card is unstamped), so the
  `INSERT ... ON CONFLICT` now stamps the person only when no other card of
  that edition already carries it, on insert through a `CASE WHEN EXISTS`
  and on conflict through the existing `COALESCE`, the same guard the
  backfill and the link stamp have. The `role_id` behaviour on conflict is
  unchanged. Test: `tests/hq/builder-onboarding.test.ts` "enrolls without
  tripping the per-edition person index when another card already carries
  the account's person". What remains for phase 3 is the other direction:
  once a roster import creates People cards for roster persons, every new
  writer of `hq_people.person_id` needs the same guard.
- The same fix round made a clear delete the detached person when nothing
  identifies it any more (no provisional Colosseum username, no card, no
  roster row) instead of orphaning it, reported `replacementPersonId` and
  `deletedPersonId` in the result and the audit metadata, and hid
  "Wrong match?" on a card whose link was cleared in the session. Tests:
  "removes a cleared person that nothing identifies any more, instead of
  orphaning it" and "keeps a cleared person that a roster row or another
  card still names", both in `tests/hq/builder-onboarding.test.ts`.
- "Wrong match?" in People only clears a link. Re-pointing and merging are
  reachable through the `correctPersonMatch` action and tested, and get a
  UI when phase 3 creates roster persons to point at.
- Captain invitations (phase 4) and every authorization helper (T1.3) are
  untouched.

### Changed interfaces, task T1.2

`Capability`, `CAPABILITIES`, `CAPABILITY_LABELS`, `CapabilityGrant`,
`CapabilityChange`, `isCapability`, `grantCapability`, `revokeCapability`,
`listActiveCapabilities`, `listActiveCapabilitiesForUsers`,
`listCapabilityGrants`, `personTags` in `lib/hq/capabilities.ts`;
`recordAuditEvent`, `listAuditEvents` in `lib/hq/audit.ts` and
`AUDIT_EVENT_KINDS`, `AuditEventKind`, `AuditActor`, `AuditEvent`,
`AuditEventInput`, `AuditEventFilter`, `AuditEventPage`,
`insertAuditEventStatement`, `listAuditEventsStatement`, `toAuditEvent` in
`lib/hq/audit-sql.ts`; `grantCaptainCapability`, `revokeCaptainCapability`
in `lib/hq/actions/capabilities.ts`; `correctPersonMatch`,
`PersonMatchCorrection` in `lib/hq/crm-identity.ts` and the
`correctPersonMatch` action in `lib/hq/actions/people.ts`; `PersonTag`,
`Person.builderUserId`, `Person.personId`, `Person.tags` in
`lib/hq/types.ts`; `operatorQuery()` in `lib/hq/queries.ts`;
`BuilderAccount.captain`, `ActiveCaptain` and the `captains` field of
`getBuilderAdminData()`; `builderDatabase`, `BuilderQuery`,
`BuilderDatabase`, `atomically` in `lib/hq/builder-db.ts` (the first three
still importable from `lib/hq/builder-store.ts`);
`pgliteBuilderDatabase(pg)` in `tests/hq/helpers/db.ts`. Tables:
`hq_account_capabilities`, `hq_audit_events`. The seeded role label
"Captain" is now "Partner captain".

### External configuration still required, task T1.2

None added. The list from task T0.1 stands.

### What changed, task T1.3

The actor representation, the central authorization helpers with typed
hooks for the phase 4 and phase 5 records, the actor-aware view models and
the widened auth-boundary test. Nothing is wired into an existing page or
action yet; that is task T1.4.

- New `lib/hq/actor.ts` (server-only): `Actor`, the one actor shape every
  service takes, with the two session origins kept distinct. The operator
  shape comes from `requireUser()` (hq_users), the member shape from
  `currentMember()` (Better Auth) plus the account's active capabilities
  (`listActiveCapabilities`, read when the actor is built) and its Telegram
  identity (`telegram.userId` is a string). `job` is reserved for phase 8.
  `currentActor()` resolves the operator session first, then the member
  session; an operator who still has to change their password is not
  handed an operator actor. `requireMemberActor(next?)` redirects like
  `requireMember()`; `requireOperatorActor()` wraps `requireUser()` and is
  the only way to obtain `kind: "operator"`. No function reads a form
  field, a query parameter, a request body or a cookie; a test scans the
  three modules for exactly that.
- New `lib/hq/authz-sql.ts` (pure, no `server-only`): `loadProjectEdition`
  (hq_projects), `loadTeamMembership` (verified owner or joined roster member
  through `hq_project_onboarding` and `hq_project_members`, with the
  project's edition; a pending or rejected claim is no membership), and the
  two typed hooks per ruling STUBS: `loadCurrentAssignment` returning null
  with a `TODO(phase 4)` and `loadEntry` returning null with a
  `TODO(phase 5)`. A malformed project id is treated as missing before it
  reaches the database.
- New `lib/hq/authz.ts` (server-only): `ProjectAction`, `Authorization`,
  `AuthzLoaders` (injectable; every call builds its own defaults over the
  builder-side pool, nothing survives a request), `getActorCapabilities`,
  `authorizeProjectAction(actor, { projectId, hackathonId, action },
  loaders?)`, `requireOperator()`, `isTeamMember`, `isAssignedCaptain`,
  `entryAudience`, `canEditEntry`, `canReadRevisionHistory` and
  `assertHackathonMatches`. Operators have full access only through their
  kind. A member is evaluated per resource: team membership first, then the
  `captain` grant read from the database together with the injected or
  loaded assignment. The actor's own capability set is never trusted for a
  decision. To a member, a project they have no relationship with is
  `not_found` whether it is missing, in another edition or someone else's;
  `wrong_edition` is only returned to a related actor asking under another
  edition; `not_member` is a related actor lacking the team relationship the
  action needs (membership changes are the team lead's, and a Captain holds
  no Captain-only permission there); `not_assigned` is a `captain` holder
  who is not the project's current Captain, and only for a project in the
  edition they asked under, so the reason cannot confirm which ids are
  projects in other editions; `no_capability` is a job actor. Member-facing
  surfaces render every denial identically. An operator is allowed without
  a lookup, so operator callers still pass the loaded record through
  `assertHackathonMatches`. `currentActor()` is wrapped in React `cache()`
  like `currentMember()`: one set of reads per request, never across
  requests.
  Entry audience follows the plan: shared entries are read by the team and
  the assigned Captain and edited by their author while still authorized on
  the project; a sensitive note is its author's and the operators', the
  author keeps a read-only view while their capability is active, editing
  again requires current project authorization, and another Captain or the
  team gets nothing. Revision history is operator-only.
- New `lib/hq/view-models.ts` (pure): `MemberTeamView` (id, name, edition,
  the viewer's own membership, the Captain's display name and approved
  contact or null), `CaptainAssignmentView` (id, name, edition, project URL,
  stage, lead username, roster names and handles), `PublicPersonView` (name
  and tag labels) with `toMemberTeamView`, `toCaptainAssignmentView` and
  `toPublicPersonView` over the existing `BuilderTeam` and `Person` rows.
  Operator-only shapes stay in `lib/hq/types.ts`.
- `tests/hq/auth-boundary.test.ts` (ruling Q9): an explicit map from every
  `"use server"` module under `lib/hq/actions` to its gate (operator or
  member), a check that the map and the directory agree in both directions,
  and `requireOperatorActor(` and `requireMemberActor(` accepted as gate
  spellings next to `requireUser(`, `currentUser(`, `requireMember(` and
  `currentMember(`.
- New `tests/hq/authz.test.ts` and `tests/hq/view-models.test.ts`.

Migrations: none. No SQL file and nothing in `scripts/hq/` changed.

### Checks passed, task T1.3

- `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`: 527 tests pass
  (494 before, 33 new).
- `npx tsc --noEmit`: clean.
- `npm run lint`: the same 18 pre-existing warnings, nothing new.
- Phase 1 gate, "a member cannot read operator data through a URL, a body
  field, a project id or the hackathon cookie": `tests/hq/authz.test.ts`
  drives `authorizeProjectAction` on PGlite with real membership and grant
  rows. A member gets `not_found` for a foreign project, a project in
  another edition, a pending claim, an unclaimed roster row, an unknown id
  and a malformed id alike; a related project under the wrong edition is
  `wrong_edition`; only `kind: "operator"` reaches `via: "operator"`, and a
  member session never passes `requireOperator()`.
- Phase 1 gate, "a `captain` grant on its own opens no project": with a
  real grant and no assignment every action is `not_assigned`; an assignment
  for an account without the grant opens nothing; an assignment to someone
  else is `not_assigned`; with the grant and an injected assignment the
  shared surface is allowed `via: "captain"` and a membership change is not.
- Phase 1 gate, "a revocation is visible on the next request": the same
  actor object is allowed, then denied after `revokeCapability`, then
  allowed again after a fresh grant; leaving a roster ends access on the
  next call; `getActorCapabilities` and `isAssignedCaptain` follow suit.
- Combined roles per resource: a Captain assigned to project A who is a
  roster member of project B is allowed on A `via: "captain"`, on B
  `via: "member"`, denied on C, and may change membership on neither.
- The section 5 entry matrix, including the reassigned Captain's read-only
  author view, another Captain getting nothing, sensitive notes hidden from
  the team, and revision history for operators only.
- `currentActor()` returns the operator actor when both sessions are
  present without consulting the member session; the member actor carries
  current grants and the Telegram id as a string beyond the safe integer
  range; the actor and authorization modules contain no form, body, query
  or cookie read.

### Blocked or deferred, task T1.3

- Wiring into `lib/hq/actions/builders.ts`, the project state actions and
  the member pages is task T1.4. Until then the helpers have no caller in
  the app and the existing per-action checks stand.
- `loadCurrentAssignment` and `loadEntry` return null until phase 4 and
  phase 5 create their tables; the decisions over them are tested with
  injected fixtures, so those phases replace one body each.
- `MemberTeamView.captain` is null until phase 4 assigns Captains, and the
  contact a Captain approves for a team is a phase 4 field.
- `Authorization.reason` includes `not_author`, reserved for entry edits by
  someone other than the author once phase 5 routes edits through an
  entry-level decision; `canEditEntry` answers that today with a boolean.
- `assertHackathonMatches` throws a `BuilderError` with one message for a
  missing record and for one from another edition; operator actions adopt
  it in T1.4.

### Changed interfaces, task T1.3

`Actor`, `OperatorActor`, `MemberActor`, `currentActor()`,
`requireMemberActor(next?)`, `requireOperatorActor()` in `lib/hq/actor.ts`;
`ProjectEdition`, `TeamMembership`, `CurrentAssignment`, `Entry`,
`EntryVisibility`, `AssignmentLoader`, `EntryLoader`,
`loadProjectEdition(db, projectId)`, `loadTeamMembership(db, { userId,
projectId })`, `loadCurrentAssignment(db, projectId)`, `loadEntry(db,
entryId)` in `lib/hq/authz-sql.ts`; `ProjectAction`, `Authorization`,
`ProjectActionRequest`, `AuthzLoaders`, `EntryAudience`,
`requireOperator()`, `getActorCapabilities(actor, loaders?)`,
`authorizeProjectAction(actor, { projectId, hackathonId, action },
loaders?)`, `isTeamMember(actor, projectId, loaders?)`,
`isAssignedCaptain(actor, projectId, loaders?)`, `entryAudience(entry,
actor, loaders?)`, `canEditEntry(actor, entry, loaders?)`,
`canReadRevisionHistory(actor)`, `assertHackathonMatches(record,
hackathonId)` in `lib/hq/authz.ts`; `TeamCaptainView`, `MemberTeamView`,
`CaptainAssignmentView`, `PublicPersonView`, `toMemberTeamView`,
`toCaptainAssignmentView`, `toPublicPersonView` in `lib/hq/view-models.ts`.
No existing export changed.

### External configuration still required, task T1.3

None added. The list from task T0.1 stands.

### What changed, task T1.4

The identity predicate and the central authorization helpers wired into the
existing member and operator surfaces. Nothing new is exposed; what already
existed is now gated in one place, and every member-facing denial is the
same not-found answer.

- `lib/hq/identity.ts`: `verifiedLoginEmail(user)` and
  `isVerifiedAccount(user)` are the one definition of "verified account" (a
  verified real email, or a Telegram identity row; a placeholder user whose
  identity row is missing fails closed). `lib/hq/member-auth.ts` imports both
  for `currentMember()` and the `user.create.after` hook and no longer holds
  a copy; `app/hq/(member)/profile/actions.ts` reads the session through
  `currentMember()` and so shares it. A test asserts the rule is defined
  once and that neither reader re-derives it.
- `lib/hq/view-models.ts`: `MemberTeamView` gains the fields the team page
  already rendered (`projectUrl`, `stage`, `lead.username`,
  `roster[{ id, name, username, joined }]`), so the page and the client
  controls take the view and nothing from `BuilderTeam`: `ownerId`,
  `description` and `hackathonName` never leave the server.
- `lib/hq/builder-store.ts`: `teamById(projectId)`, a read with no
  relationship filter for a caller that has already authorized;
  `ownClaim(userId, projectId)`, the account's own still-unverified claim,
  read by account like the dashboard's import requests; `realEmail`
  exported. `teams()` is unchanged in behaviour over a shared select.
- New `lib/hq/member-teams.ts` (server-only): `authorizedTeam(actor,
  { projectId, hackathonId?, action })` and `memberTeamView(actor,
  projectId)`, the store call the team page and the team actions share:
  `loadProjectEdition`, then `authorizeProjectAction` with that edition
  injected, then the row only once the decision allows. Every denial is
  null and, in an action, `TEAM_NOT_AVAILABLE`. It sits beside the store
  because `builder-store.ts` is imported by `member-auth.ts`, which
  `actor.ts` and `authz.ts` depend on, so the store cannot import `./authz`
  without a cycle. The `hq_hackathon` cookie is never read on this path.
- `lib/hq/actions/builders.ts`: `saveBuilderTeam({ projectId, hackathonId,
  stage, leadUsername })` and `createBuilderInvite({ projectId, hackathonId,
  memberId })` gate with `requireMemberActor()` and then call
  `authorizedTeam(..., "membership.change")`, the team lead's action in the
  permission contract, before any read or write. The edition the member
  asked under travels in the body and is checked against the project. A
  foreign, other-edition, pending, unknown or malformed id and a crafted
  body edition all answer `TEAM_NOT_AVAILABLE`, identical to a missing team,
  and nothing is fetched or written. The store's own owner and verification
  predicates still run inside the write transaction as the last line of
  defence, not as the decision. `components/hq/builder-onboarding.tsx`
  sends `hackathonId: team.edition.id` and takes a `MemberTeamView`.
- `app/hq/(member)/team/[id]/page.tsx`: `requireMemberActor()` then
  `memberTeamView()`; `notFound()` for every denial; renders only
  `MemberTeamView` fields.
- `lib/hq/actions/util.ts`: `inHackathon(record, hackathonId)` wraps
  `assertHackathonMatches` and returns null on its `BuilderError`, so a
  missing record and one from another edition are the same answer.
  `lib/hq/actions/projects.ts`: the eight R3 section 5 actions that took
  the record's own edition (`setProjectStatus`, `setProjectForecast`,
  `toggleProjectGate`, `saveProjectBlocker`, `addProjectNote`,
  `deleteProject`, `editProjectNote`, `logMondayReview`) now call
  `requireHackathon()` and resolve their record through `inHackathon`; the
  four that already compared editions inline (`updateProjectDetail`,
  `addProjectMember`, `updateProjectMember`, `removeProjectMember`) use the
  same helper instead. `lib/hq/actions/people.ts`: `updatePerson` likewise.
  Each keeps its existing not-found result and returns it for both cases.
- `lib/hq/builder-admin-queries.ts` (ruling Q2): every account-bearing row
  carries `AccountLogin = { email, telegram: { username } | null }` (a
  `LEFT JOIN` on `hq_auth_telegram_identity`; `email` through `realEmail`,
  so the placeholder can never reach a page even from a row that holds it),
  `BuilderAccount.contactEmail`, and `BuilderProjectReview.owner` replaces
  `ownerEmail`. `components/hq/builder-admin.tsx`: `loginLabel()` renders
  the email, else "Telegram: @username", else "Telegram account"; the
  account row shows "Contact email: ..." only when one is set.
- New `tests/hq/member-actions-authz.test.ts`; additions to
  `tests/hq/builders-admin.test.ts` (applies `member-auth-schema.sql`,
  keeps `inHackathon` real), `tests/hq/member-auth.test.ts` and
  `tests/hq/view-models.test.ts`.

Behaviour change to record: the owner of an import still awaiting or
refused review sees their claim and its status on the team page, but can no
longer change the stage or lead until the team is verified; the save form
and the invite buttons are shown only to the verified team lead, and the
pending copy says so. The T1.3 loader recognises verified relationships
only, per the plan ("Imported roster membership and a verified HQ account
relationship are different things"; "Preserve pending status until
review"), and the write path must not carry a second rule for claimants.

Migrations: none. No SQL file and nothing in `scripts/hq/` changed.

### Checks passed, task T1.4

- `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`: 543 tests pass
  (527 before, 16 new).
- `npx tsc --noEmit`: clean.
- `npm run lint`: the same 18 pre-existing warnings, nothing new.
- Mutation checks: removing the `authorizedTeam` call from `saveBuilderTeam`
  fails 6 of the 11 new member tests; making `inHackathon` ignore the
  edition fails 2 admin tests. Both restored.
- Ruling Q2: `tests/hq/builders-admin.test.ts` "carries the Telegram
  identity and the contact email apart from the login email, never the
  placeholder" and "renders a Telegram-only account as its handle, the
  contact email labelled apart, and an email account as before" (the rows
  rendered through `react-dom/server`).
- Ruling Q3: auto-enrolment on read is unchanged; `tests/hq/member-auth.test.ts`
  "completes a Telegram-only profile through the one verified-account rule
  and never writes the placeholder" and "defines the verified-account rule
  once, in lib/hq/identity.ts, and every session reader imports it".

Phase 1 acceptance checklist, with the test that proves each item:

1. Additive migrations apply twice, on a fresh and on a populated database,
   through the statement splitter: passed, `tests/hq/migration-order.test.ts`
   (tasks T1.1 and T1.2).
2. A member cannot read operator data through a URL, a body field, a project
   id or the hackathon cookie: passed, `tests/hq/member-actions-authz.test.ts`.
   URL: "answers a foreign, other-edition, unknown or malformed id with the
   same not-found page, whatever the URL says". Body field and project id:
   "answers a foreign team, another edition's team, a pending claim, an
   unknown id and a crafted body edition identically, and changes nothing".
   Cookie: "never reads the hackathon cookie: a tampered value changes no
   answer". The view carries no operator field: "renders the member's own
   view of a verified team and nothing wider". Operator side, a swapped
   cookie or id reaches no other edition's record:
   `tests/hq/builders-admin.test.ts` "answers a record from another edition
   exactly like a missing one in every project state action and the People
   editor". The decision matrix itself: `tests/hq/authz.test.ts` (T1.3).
3. A `captain` grant on its own opens no project: passed,
   `tests/hq/member-actions-authz.test.ts` "gives a captain grant no team
   action on its own, and no lead-only action through a roster seat" and the
   `cap` cases of the URL test; `tests/hq/authz.test.ts` "gives a captain
   grant nothing without an assignment, and the shared surface with one".
4. Editing a People role or tag cannot grant `captain`: passed,
   `tests/hq/builders-admin.test.ts` "never turns a People role edit, a new
   person or a tier change into a Captain grant" (T1.2).
5. A revocation is visible on the next request: passed,
   `tests/hq/member-actions-authz.test.ts` "sees a lost relationship on the
   very next call" and "loses the page on the next request after leaving the
   roster, without a session change"; `tests/hq/authz.test.ts` "sees a
   revocation on the very next call, with the same actor object and no
   caching in between"; the Admin and People reads in T1.2. "Including bot
   requests" is deferred to phase 7: no bot exists yet, and the new test
   file's header records the deferral.
6. Existing `hq_users` ids, credentials and People links survive the
   migration: passed, `tests/hq/migration-order.test.ts` (T1.1).
7. Grant plus audit, and link plus identity, are written atomically: passed,
   `tests/hq/capabilities.test.ts` "rolls the grant back when the audit event
   cannot be written" and `tests/hq/builder-onboarding.test.ts` "links a
   roster person to an account and stamps the account's cards, both or
   neither" and "refuses an unknown person or account, and rolls everything
   back when the audit write fails" (T1.1, T1.2).

### Blocked or deferred, task T1.4

- Bot requests, and revocation as seen by the bot: phase 7.
- A claimant editing their pending import's stage or lead: not possible
  until the team is verified (see the behaviour change above). Reversing
  that would need a second, claimant-only rule on the write path; it is a
  product ruling, not a one-line change.
- Section 2, "Email users see Connect Telegram in the menu and dashboard":
  the data is available (`getLoginMethods` from T1.1, `MemberActor.telegram`
  from T1.3); the menu and the dashboard prompt are task T2.4.
- The team page for an assigned Captain, and `MemberTeamView.captain`, are
  phase 4.
- `BuilderStore.team(userId, id)` (the account-scoped lookup that throws) has
  no caller in the app any more; it stays for the store tests until a later
  clean-up.

### Changed interfaces, task T1.4

`verifiedLoginEmail(user)`, `isVerifiedAccount(user)`, `StoredAccount` in
`lib/hq/identity.ts`; `MemberTeamView.projectUrl`, `.stage`, `.lead`,
`.roster` in `lib/hq/view-models.ts`; `BuilderStore.teamById(projectId)`,
`BuilderStore.ownClaim(userId, projectId)`, `realEmail` in
`lib/hq/builder-store.ts`; `authorizedTeam`, `memberTeamView`,
`TEAM_NOT_AVAILABLE` in `lib/hq/member-teams.ts`; `inHackathon` in
`lib/hq/actions/util.ts`; `saveBuilderTeam` and `createBuilderInvite` take
`hackathonId`; `BuilderTeamControls` takes `{ team: MemberTeamView }`;
`AccountLogin`, `TelegramLogin`, `BuilderAccount.telegram`,
`BuilderAccount.contactEmail`, `BuilderHostRequest.telegram`,
`BuilderImportRequest.telegram`, `BuilderProjectReview.owner` (replacing
`ownerEmail`) in `lib/hq/builder-admin-queries.ts`; `loginLabel` in
`components/hq/builder-admin.tsx`. `MemberSessionUser`, `Actor`,
`authorizeProjectAction` and `assertHackathonMatches` are unchanged.

### External configuration still required, task T1.4

None added. The list from task T0.1 stands.

### Phase 1 summary and acceptance checklist

Tasks T1.1, T1.2, T1.3 and T1.4, closed out in task T2.6. The checklist under
"Checks passed, task T1.4" maps the seven **gate** items in
`docs/hq/contracts.md`. This checklist maps the plan's own five phase 1
acceptance bullets, quoted verbatim, so that every plan bullet has a named test
or an explicit deferral.

**What changed and which migrations apply.** One stable public account id
whatever it signs in with, a CRM person behind every People card, an
admin-controlled `captain` capability with an append-only audit trail, one
central authorization module, and all of it wired into the existing member and
operator surfaces. Migrations, all additive and all listed in full in the
per-task entries above: in `scripts/hq/builder-schema.sql` the nullable
`hq_builder_profiles.email`, the new `hq_builder_profiles.contact_email`, the
new tables `hq_crm_persons`, `hq_account_capabilities` and `hq_audit_events`,
the new `person_id` columns on `hq_people` and `hq_project_members` with
`hq_people_person_idx` and the two backfills; in `scripts/hq/upgrades.ts` one
guarded step renaming the seeded "Captain" People role to "Partner captain".
T1.3 and T1.4 added no SQL.

**Acceptance checklist.**

1. "A regular account cannot read operator data by changing a URL, request body,
   project ID or hackathon cookie." Passed.
   - URL: `tests/hq/member-actions-authz.test.ts` "answers a foreign,
     other-edition, unknown or malformed id with the same not-found page,
     whatever the URL says".
   - Request body and project ID: the same file's "answers a foreign team,
     another edition's team, a pending claim, an unknown id and a crafted body
     edition identically, and changes nothing".
   - Hackathon cookie: the same file's "never reads the hackathon cookie: a
     tampered value changes no answer".
   - No operator field reaches a member response: the same file's "renders the
     member's own view of a verified team and nothing wider", and
     `tests/hq/view-models.test.ts` "carries the team page's fields, the
     viewer's own membership and the Captain's approved contact, and no other
     account's identity".
   - The decision matrix behind all four: `tests/hq/authz.test.ts` "makes a
     foreign, other-edition, pending, unknown or malformed project
     indistinguishable from a missing one", "refuses a related project under the
     wrong edition", "never grants a member through the operator branch, and a
     job nothing at all", "requireOperatorActor and requireOperator wrap
     requireUser and never admit a member session" and "takes no identity from a
     request: no form, body, query or cookie read anywhere in the actor or
     authorization modules".
   - The operator side of the same rule: `tests/hq/builders-admin.test.ts`
     "answers a record from another edition exactly like a missing one in every
     project state action and the People editor".
2. "A Captain capability grants no project access without assignment, except
   legitimate team membership." Passed, `tests/hq/authz.test.ts` "gives a captain
   grant nothing without an assignment, and the shared surface with one",
   "evaluates combined roles per resource", "reads the grant from the database,
   never from the actor's own capability set" and "lets an unassigned Captain
   learn nothing about projects outside the requested edition";
   `tests/hq/member-actions-authz.test.ts` "gives a captain grant no team action
   on its own, and no lead-only action through a roster seat". The "except
   legitimate team membership" half is `tests/hq/authz.test.ts` "gives a team
   member read, create, edit and the Captain assignment; membership changes are
   the lead's alone".
3. "Editing an ordinary People tag cannot grant Captain or admin permissions."
   Passed, `tests/hq/builders-admin.test.ts` "never turns a People role edit, a
   new person or a tier change into a Captain grant" and "keeps the renamed
   Partner captain role an ordinary, editable role beside the Captain
   capability"; `tests/hq/capabilities.test.ts` "renders the role tag first and
   one locked tag per capability". No path exists from a public account to an
   `hq_users` row: `tests/hq/authz.test.ts` "requireOperatorActor and
   requireOperator wrap requireUser and never admit a member session".
4. "Revocation affects the next protected request, including bot requests."
   Passed for web requests, `tests/hq/authz.test.ts` "sees a revocation on the
   very next call, with the same actor object and no caching in between";
   `tests/hq/member-actions-authz.test.ts` "sees a lost relationship on the very
   next call" and "loses the page on the next request after leaving the roster,
   without a session change"; `tests/hq/builders-admin.test.ts` "grants and
   revokes Captain from Admin with the operator recorded, visible on the next
   read". **"Including bot requests" is deferred to phase 7**: no bot exists, no
   bot request path exists, and nothing can be asserted about one. The deferral
   is recorded in the header of `tests/hq/member-actions-authz.test.ts`.
5. "Existing admin account IDs, credentials and CRM People relationships survive
   additive, repeatable schema changes." Passed,
   `tests/hq/migration-order.test.ts`: "takes the whole migration twice without
   drift", "keeps operator logins and People links, and gives every linked
   People card its person", "contain nothing the one-statement-per-call runner
   cannot send" and "has every hq_ table classified in the reset manifest, and
   nothing classified that does not exist"; `tests/hq/reset.test.ts` "names every
   table in the schema as either cleared or kept" and "keeps everyone logged in".

**Blocked or deferred out of phase 1, with the phase that owns each.**

- Revocation as a bot request sees it: **phase 7**.
- `loadCurrentAssignment` and `loadEntry` return null until their tables exist:
  **phase 4** and **phase 5**. Each phase replaces one function body; the
  decisions over them are already tested with injected fixtures.
- `MemberTeamView.captain`, the Captain's approved contact for a team, and the
  `/hq/captain` assignment list: **phase 4**.
- `Authorization.reason` includes `not_author`, reserved for entry-level edit
  decisions: **phase 5**.
- Re-pointing and merging a person from the People UI: **phase 3**, when a
  roster import creates roster persons to point at. The action and its merge are
  already implemented and tested.
- The reset classification of `hq_builder_enrollments`,
  `hq_project_challenges`, `hq_project_import_requests` and
  `hq_event_host_requests` preserves the pre-T1.1 behaviour and awaits a product
  ruling, not a phase.
- A claimant editing their pending import's stage or lead: a product ruling, not
  a phase. Recorded under "Blocked or deferred, task T1.4".

**Changed interfaces and external configuration.** See the four per-task
"Changed interfaces" sections above; the phase 3 shortlist is in
`docs/hq/contracts.md` under "Handoff to phase 3". Phase 1 added no environment
variable.

## Phase 2, sign-in, linking and the member shell

### What changed, task T2.1

Google and GitHub public sign-in is gone. `lib/hq/member-auth-config.ts` no
longer reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID` or
`GITHUB_CLIENT_SECRET`, and `MemberAuthAvailability` is now exactly
`{configured, email, telegram}`. `lib/hq/member-auth.ts` passes no
`socialProviders` option at all: the only OAuth provider is Telegram, which the
`hqTelegramIdentity` plugin puts on the context in its `init`.
`app/hq/(member)/account-form.tsx` lost the two "Continue with…" buttons, the
`signInSocial` helper, the "will be available soon" hint, the "or use email"
divider and the `authError` prop (that prop existed only to surface the OAuth
`?error=` round trip, so `signin/page.tsx` and `signup/inactive-page.tsx` stopped
passing it). Email is the only sign-in method now, so the unavailable-state copy
says "Sign-in is not available yet", not "Email sign-in is not available yet".
A comment marks where task T2.2 puts the Telegram button and its divider.
`account.module.css` lost `.social`, `.divider` and their hover and transition
rules; `.submit` absorbed the base rule it used to share with `.social button`.
No migration. `hq_auth_account`, `encryptOAuthTokens`, `account.accountLinking`
and `lib/hq/github-actions-auth.ts` (GitHub Actions OIDC for the Luma sync, a
different stack) are untouched, as is operator login.

`env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`: 545 tests pass (543
before), `npx tsc --noEmit` clean, `npm run lint` unchanged at the same 18
pre-existing warnings in `public/deck/deck-stage.js`.

### Checks passed, task T2.1

- Google and GitHub are absent from the public auth flow:
  `tests/hq/member-auth.test.ts` "no longer offers google/github sign-in,
  whatever the environment holds" stubs all four credential variables and gets
  404 `PROVIDER_NOT_FOUND` from `/api/auth/sign-in/social` for each.
- The availability shape is exactly `{configured, email, telegram}` and the
  four removed variables change nothing:
  `tests/hq/member-auth-config.test.ts` "reports exactly the configured, email
  and telegram flags" and "gives the removed Google and GitHub credentials no
  effect".
- Operator login still works: `tests/hq/operator-auth-actions.test.ts` and
  `tests/hq/authz.test.ts` pass unchanged; nothing under `hq_users` or
  `lib/hq/actions/auth.ts` was touched.
- Telegram sign-in is unaffected by the removal of the `socialProviders`
  option: `tests/hq/member-auth-telegram.test.ts` passes unchanged.

### Blocked or deferred, task T2.1

- The Telegram button, its error copy and the account page are task T2.2. This
  task deliberately left the sign-in page email-only.
- Deleting the four variables from the Vercel project is a live step for the
  owner; it is recorded in `docs/hq/manual-setup.md` under "Remove legacy
  providers". Nothing reads them any more, so leaving them set changes no
  behaviour.

### Changed interfaces, task T2.1

`MemberAuthAvailability` in `lib/hq/member-auth-config.ts` drops `google` and
`github`. `AccountForm` in `app/hq/(member)/account-form.tsx` drops the optional
`authError` prop.

### External configuration still required, task T2.1

None added. Four names are now removable rather than required:
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`.

### What changed, task T2.2

Telegram sign-in, Connect Telegram with a confirmation step, and the identity
plugin's phase 2 rules. No migration: the confirmation intent is a single-use
row in the existing `hq_auth_verification` table.

`lib/hq/telegram-identity-plugin.ts` gained a third before hook over the four
endpoints that add or remove a login method (`/link-social`,
`/unlink-account`, `/email-otp/request-email-change`,
`/email-otp/change-email`). It requires a session and refuses one created
`RECENT_SESSION_MS` (15 minutes) or more ago with 403 `SESSION_NOT_FRESH`.
Better Auth keeps no re-authentication time, so the rule compares
`session.createdAt`, the moment of sign-in (a refresh under `updateAge`
touches only `updatedAt`, and the core's own `freshSessionMiddleware`
compares `createdAt` too); the only way to become recent again is to sign
in. On `/link-social` for Telegram the hook also refuses an account that
already has an identity row (409 `TELEGRAM_ALREADY_CONNECTED`) and consumes
the recorded confirmation intent, refusing with 403 `CONFIRMATION_REQUIRED`
when there is none, it expired, it was for the other action or it was
already used. On `/unlink-account` for a Telegram account row it refuses when
no verified real email remains (400 `LAST_LOGIN_METHOD`; the core's own rule
counts account rows, which an email-OTP user does not have, so
`allowUnlinkingAll: true` hands the decision to the plugin) and then consumes
the unlink intent. `account.create.before` additionally refuses a second
Telegram account row for a user who already has an identity row
(`telegram_already_connected`), the in-transaction backstop for the endpoint
check. `account.create.after` writes the identity row and an
`identity.linked` audit event in one builder-pool transaction;
`account.delete.after` deletes the row and writes `identity.unlinked` when a
row was actually removed. Metadata is `{ provider: "telegram" }` and nothing
else. A repeat sign-in refreshes the row and records nothing. The provider's
rejection diagnostics now go through Better Auth's logger (`ctx.logger.warn`
in the plugin's `init`) unless a sink is injected. Exported for the rest of
the code: `isRecentSession`, `telegramIsLastLoginMethod`,
`recordTelegramIntent`, `TELEGRAM_INTENT_MS`, and the three guard lists.

`lib/hq/actions/telegram.ts` (`"use server"`, member gated):
`confirmLinkTelegram()` and `confirmUnlinkTelegram()`. Each starts with
`requireMemberActor()`, re-checks the same rules the plugin enforces so the
page can explain a refusal (`SESSION_NOT_FRESH`, `TELEGRAM_UNAVAILABLE`,
`TELEGRAM_ALREADY_CONNECTED`, `TELEGRAM_NOT_CONNECTED`, `LAST_LOGIN_METHOD`),
records the intent, and returns; the unlink confirmation also returns the
Better Auth account row id the client passes to `unlinkAccount()`. Neither
action links or unlinks anything itself.

`lib/hq/member-auth.ts`: `currentMemberSession()` (the raw session, cached
per request, read by the actions for `createdAt` and the stored login fields;
`currentMember()` now builds on it) and `redirectToMemberSignIn(next)`. The
latter handles the state the T0.1 review flagged: a session that exists but
fails the verified-account rule (a Telegram-only account whose post-commit
identity row never landed) is ended by deleting its session row, and the
person is sent to `/hq/signin?error=identity_missing`, where the form says
"Your Telegram sign-in did not complete. Please sign in again." The next
Telegram sign-in repairs the row. `requireMember()`, the profile page and
`completeMemberProfile` all go through it.

`app/hq/(member)/account-form.tsx`: "Continue with Telegram" above the email
form, calling `signIn.social({ provider: "telegram", callbackURL,
errorCallbackURL: "/hq/signin?error=telegram&next=...",
newUserCallbackURL: "/hq/profile?next=..." })`, so a first-time Telegram
account lands on the existing name step, which asks for no email. The
unavailable state is per method and per mode: "Telegram sign-in is not
available yet. Use email below.", "Email sign-up is not available yet. Use
Telegram above.", or a single "Sign-in is not available yet" line when
neither is configured. The form takes an `error` code (the signin page reads
the last `error` value, because Better Auth appends its own code after ours)
and `app/hq/(member)/telegram-copy.ts` maps the codes to copy:
`account_already_linked_to_different_user` and `telegram_identity_conflict`
("This Telegram account is already connected to another HQ account. Sign in
to that account instead."), `state_mismatch`, `SESSION_NOT_FRESH` ("Please
sign in again to continue."), `identity_missing`, and a generic line for the
other callback codes. The helper is a plain module because the server-rendered
account page uses the same copy.

New pages: `/hq/account` (login methods from `getLoginMethods()`: the
verified address or "None. This account signs in with Telegram only.";
"Connected as @username" or "Not connected"; Connect Telegram, or Disconnect
Telegram disabled with the reason when it is the last login method),
`/hq/account/connect-telegram` and `/hq/account/disconnect-telegram` (the
confirmation steps; a shared client form runs the server action and only then
calls `linkSocial()` or `unlinkAccount()`; a stale session gets a "Sign in
again" button that signs out and returns to the same step), plus
`account/loading.tsx`. All three pages call `requireMemberActor()`. The page
renders only server data; nothing reads the auth client's session object, and
a test asserts the Telegram-only markup contains neither the placeholder
address nor the subject. `proxy.ts` and `safeMemberNext` both list the three
routes (T2.4 unifies the lists).

Fix round 1 of the task review added three things. `scripts/hq/member-auth-schema.sql`
gained `hq_auth_account_telegram_user_idx`, a partial unique index on
`hq_auth_account("userId") WHERE "providerId" = 'telegram'` (one idempotent
statement), so two in-flight link callbacks cannot leave a user with two
Telegram account rows even when the `account.create.before` backstop has no
identity row to see; the race then fails with a unique violation and nothing
is written. `lib/hq/member-auth.ts` sets
`disabledPaths: ["/get-access-token", "/refresh-token", "/account-info"]`,
the three library endpoints that would echo the stored provider tokens,
including the Telegram id_token, to the session holder; they answer 404. This
completes Ruling Q18: the stored id_token is read by the identity plugin's
database hooks and by nothing else, and no endpoint returns it. And the copy
helper now takes every `error` value the URL carries: a mapped code wins
wherever it sits, any other code next to our `telegram` marker (a cancel at
Telegram arrives as `access_denied`) is shown as a Telegram failure, and an
unrelated `?error=` is still ignored; a failed `signIn.social` call falls back
to the same Telegram line, not to the email-code copy.

### Checks passed, task T2.2

- Synthesis §2.6 steps 10 to 13 and 15 to 16, in
  `tests/hq/member-auth-telegram.test.ts` (20 tests, 9 new): link from an
  email account through the confirmation step, `/link-social` and the
  callback, with the account id, profile, enrollment, capability grant and
  team row unchanged and one `identity.linked` event; an unconfirmed,
  expired, wrong-action, foreign or already-used confirmation refused with
  no OAuth state minted; a link that fails at the token exchange leaves no
  row and cannot be replayed; a second Telegram refused at the endpoint and
  by `account.create.before`; a Telegram account held by another HQ account
  refused with `account_already_linked_to_different_user` and nothing moved;
  a 16 minute old session refused on all four endpoints and by both actions
  while a 14 minute old one passes; no session, the operator cookie and a
  cross-origin request refused on `/link-social`; a Telegram-only account
  cannot disconnect (action, endpoint and page agree); a linked account
  disconnects after confirmation, with `identity.unlinked` recorded and the
  next Telegram sign-in starting a new account; the account page markup for
  Telegram-only, email-only and error states; the missing identity row
  ending the session at page and action level; a Telegram-first account
  without a name completing the name step with no email prompt. Every
  guarded and gated route template exists on the installed library.
- `tests/hq/telegram-identity-plugin.test.ts` (new, 6): the three guard
  lists, the hook matchers per route template, the recency boundary and the
  last-login-method rule.
- `tests/hq/account-form.test.ts` (new, 7): Telegram first and email
  second, the unavailable state per method and per mode, the error copy, no
  Google or GitHub remnant, no em dashes or middots.
- `tests/hq/member-auth-config.test.ts`: the three account routes preserved
  and near-misses rejected. `tests/hq/auth-boundary.test.ts` maps
  `telegram.ts` to the member gate. `tests/hq/member-auth.test.ts` asserts
  the ended session for the missing-row state.
- Phase 2 gate items covered here: Telegram-only, email-only and linked
  accounts sign in and land on the safe `next`; linking preserves the account
  id, teams and grants; a failed or expired login or link grants nothing; an
  unconfigured Telegram shows an honest unavailable state; admin login is
  untouched (`tests/hq/operator-auth-actions.test.ts` unchanged).

### Blocked or deferred, task T2.2

- Recovery email for Telegram-first accounts and bot-messaging consent are
  task T2.3. The account page shows "Add a verified email first" without a
  link until then, and the two change-email endpoints sit behind the recency
  hook already.
- The member navigation and the single route allowlist are task T2.4; the
  account page is reachable by URL and from the confirmation steps only.
- The rate limit and cookie review is task T2.5. `/link-social` and
  `/unlink-account` fall under the repo's 60 per minute default.
- A `customSession` transform was not added at the time: no client code read
  `session.user` (grep over `app`, `components` and the auth client), and the
  placeholder guard was the markup test plus the server-only readers. The
  whole-branch review promoted this to an Important finding and it is fixed:
  `lib/hq/member-auth.ts` now carries a `customSession` transform that maps a
  placeholder `user.email` to null and `emailVerified` to false, so
  `/get-session` and `api.getSession()` alike hand out no placeholder.
- The `account.create.before` backstop for a second Telegram fires inside the
  link callback outside any redirect wrapper, so a race that reaches it (or
  the unique index behind it) answers a JSON error instead of an error
  redirect. The endpoint hook stops the same case with a redirectable refusal
  first.

### Changed interfaces, task T2.2

`lib/hq/telegram-identity-plugin.ts` exports `isRecentSession(session, now?)`,
`telegramIsLastLoginMethod(user)`, `recordTelegramIntent(store, userId,
intent)`, `TELEGRAM_INTENT_MS`, `PLACEHOLDER_GUARDED_ENDPOINTS`,
`ID_TOKEN_ENDPOINTS`, `RECENT_SESSION_ENDPOINTS` and the types
`TelegramIntent`, `TelegramIntentStore`. `lib/hq/identity.ts`:
`upsertTelegramIdentity(input, db?)` and `deleteTelegramIdentity(userId, db?)`
take an optional query handle, and the delete returns whether a row went.
`lib/hq/member-auth.ts` exports `currentMemberSession()` and
`redirectToMemberSignIn(next)`. `lib/hq/actions/telegram.ts` exports
`confirmLinkTelegram()`, `confirmUnlinkTelegram()` and their result types.
`AccountForm` takes an optional `error` prop (a string or the whole
`string[]` the URL carried). `app/hq/(member)/telegram-copy.ts` exports
`lastParam(value)`, `telegramErrorMessage(error, action?)`,
`telegramFailure(action)` and `LAST_LOGIN_METHOD_COPY`.
`account.accountLinking.allowUnlinkingAll` is now true and `disabledPaths`
lists the three token endpoints. Migration: the additive
`hq_auth_account_telegram_user_idx` in `member-auth-schema.sql`.

### External configuration still required, task T2.2

`TELEGRAM_LOGIN_CLIENT_ID`, `TELEGRAM_LOGIN_CLIENT_SECRET` (both needed for
the button to be live), `TELEGRAM_BOT_USERNAME` (copy only). The redirect URL
to register is `<BETTER_AUTH_URL>/api/auth/callback/telegram`; see
`docs/hq/manual-setup.md`.

### What changed, task T2.3

A Telegram-first account can add a verified recovery email, and bot
messaging is a separate, revocable decision. One additive table.

`lib/hq/member-auth.ts` enables the emailOTP change-email flow
(`changeEmail: { enabled: true, verifyCurrentEmail: false }`, verified in
`node_modules/better-auth/dist/plugins/email-otp/routes.mjs`): the code goes
to the new address only, and the current address is never asked for one, so
a placeholder is never mailed. A `databaseHooks.user.update.after` hook reads
the previous address from the endpoint context's session (the cookie is
refreshed only after `updateUser` returns, and `setSessionCookie` does not
mutate `ctx.context.session`); when it was a verified real address it is sent
a plain notice through the one `deliver()` helper (which refuses placeholders
and returns false when email is unconfigured or Resend fails), an
`identity.email_changed` event is recorded with `{ hadPreviousEmail }` and
nothing else, and the builder profile is re-synced. A Telegram-first account
had only the placeholder, so nothing is sent and `hadPreviousEmail` is false.
The sign-in and change-email codes now share `deliver()`; the change-email
message says what the code is for.

`lib/hq/telegram-identity-plugin.ts`: `TelegramIntent` gained
`"change-email"`, recorded with the confirmed address
(`recordTelegramIntent(store, userId, "change-email", address)`), and the
recency hook consumes it on `/email-otp/request-email-change`, refusing a
request for any other address with 403 `CONFIRMATION_REQUIRED`. The core
`/change-email` joined both `RECENT_SESSION_ENDPOINTS` and
`PLACEHOLDER_GUARDED_ENDPOINTS` although it stays disabled (a test pins
`CHANGE_EMAIL_DISABLED`). The `user.update.before` placeholder guard is
tighter: a placeholder passes only on `/callback/:id` with `params.id`
`telegram` and only when a user already holds exactly that address, which by
email uniqueness means the update is a rewrite of the holder's own
placeholder (the core's `overrideUserInfoOnSignIn` path); any other
placeholder, another provider's callback and both change-email routes are
refused. `account.delete.after` revokes bot consent in the same builder-pool
transaction as the identity row removal. `normalizeEmailAddress(value)` is
the one spelling of an address on its way to the endpoints.

New `lib/hq/telegram-consent.ts` (server-only): `getBotConsent(userId)`,
`setBotConsent(actor, enabled)` (re-reads the Telegram identity, throws
`TelegramNotConnectedError` without one, idempotent, writes the row and a
`bot.consent_changed` event with `{ enabled }` in one transaction) and
`revokeBotConsent(userId, db)` (turns messaging off through the caller's
handle and records `{ enabled: false, cause: "telegram_disconnected" }` only
when an enabled consent was revoked). `bot.consent_changed` joined
`AUDIT_EVENT_KINDS`.

`scripts/hq/builder-schema.sql`: `hq_telegram_bot_consent(user_id text PRIMARY
KEY REFERENCES hq_builder_profiles(id) ON DELETE CASCADE, telegram_user_id
bigint NOT NULL, messaging_enabled boolean NOT NULL DEFAULT false,
consented_at timestamptz, revoked_at timestamptz, updated_at timestamptz NOT
NULL DEFAULT now())`, one `CREATE TABLE IF NOT EXISTS`; classified KEEP in
`scripts/hq/reset-statements.ts`. `hq_users` untouched.

`lib/hq/actions/telegram.ts`: `confirmEmailChange(newEmail)` (member gate,
email availability, shape and placeholder check, recency, not the current
address, then the bound intent; whether the address is taken is never
revealed) and `setBotMessaging(enabled)` (member gate, then
`setBotConsent`). `app/hq/(member)/account/page.tsx` shows Add a recovery
email for a Telegram-only account (the honest unavailable line when email is
unconfigured), the `?email=added` notice, and a Bot messages section only
when Telegram is connected: Enabled or Disabled from the stored row, copy
saying HQ can send Wednesday reminders only when enabled and that website
access is the same either way, and the `BotMessagingToggle` control. New
`/hq/account/add-email` (server-rendered confirmation step; an account that
already has a verified email is sent back) with `AddEmailForm`: the address
step runs `confirmEmailChange` then `emailOtp.requestEmailChange`, the
verify step runs `emailOtp.changeEmail`, with resend (each send is its own
confirmation), Use a different address and the Sign in again affordance for
a stale session. Copy for the endpoint outcomes lives in
`app/hq/(member)/account/email-copy.ts`; `telegram-copy.ts` now looks codes
up with `Object.hasOwn` and knows `EMAIL_UNAVAILABLE`, `INVALID_EMAIL` and
`EMAIL_UNCHANGED`. The route joined the proxy allowlist and `safeMemberNext`
(both lists become one in task T2.4).

Fix round 1 of the task review added five things. The notice to a previous
verified login address no longer names the new address, so a mailbox that
has changed hands cannot learn the account's new identifier from it; the
notice still says that the login email changed and still carries no code.
Three shared pieces replaced the copies each form had grown:
`app/hq/(member)/use-resend-cooldown.ts` (one resend cooldown hook),
`app/hq/(member)/otp-code-field.tsx` (one code field with one-time-code
semantics and the resend button that counts down) and
`app/hq/(member)/stale-session.tsx` (one "Sign in again" control), now used
by the sign-in form, the Telegram confirmation step and the recovery-email
form alike. `lib/hq/member-auth.ts` gained a null guard on the
`user.update.after` hook for an update that carries no email. The
`?email=added` notice renders only when the address really was added. And a
test pins that the core `/delete-user` route stays disabled. Tests:
`tests/hq/account-form.test.ts` "renders the sign-in-again control a stale
session needs, disabled with its form" and "renders the code field with
one-time-code semantics and a resend button that counts down";
`tests/hq/member-auth-telegram.test.ts` "tells the previous verified
address, once, when the login email changes" and "keeps the core delete-user
route disabled".

### Checks passed, task T2.3

- Synthesis §2.6 step 14 in `tests/hq/member-auth-telegram.test.ts` (31
  tests, 8 new): a Telegram-first account refused without confirmation, a
  confirmation spent on a request for another address, one code to the new
  address and no other message, a wrong code refused, the change to a
  verified real address with the same id, `hadPreviousEmail: false`, the
  profile email populated, the account page showing the address and the
  disconnect link, email OTP sign-in resolving to the same account, and
  Telegram then disconnected with the identity row gone.
- The previous verified address notified exactly once (two messages: the
  code to the new address, the notice without a code to the old), with
  `hadPreviousEmail: true`.
- A request for an address another account holds answers exactly like one
  for a free address, sends nothing to it and stores no code (the library's
  non-enumerating branch).
- A 16 minute old session refused on `/email-otp/request-email-change`,
  `/email-otp/change-email` and `/change-email` even with an intent written
  directly, `confirmEmailChange` answering `SESSION_NOT_FRESH`, and the
  unlink rule still holding afterwards (`LAST_LOGIN_METHOD` from the action
  and the endpoint).
- The core `/change-email` answers 400 `CHANGE_EMAIL_DISABLED` for a fresh
  session and sits in both guard lists (`tests/hq/telegram-identity-plugin.test.ts`).
- The placeholder refused as `newEmail` by the confirmation (three
  spellings), by both change-email routes, and by `updateUser` on every
  route; on the Telegram callback a held placeholder may be rewritten, a new
  one may not, another provider's callback may not, and an account with a
  real address keeps it (hook refusal, then the unique index).
- Consent separate from the connection: no row after connecting, the page
  saying Disabled, enable and disable through the action with the audit
  events, a repeat recording nothing, `currentMember()` and `requireMember()`
  unchanged after declining, an email-only account refused with
  `TELEGRAM_NOT_CONNECTED` and no Bot messages section; disconnecting
  Telegram revokes consent in the same operation with the
  `telegram_disconnected` cause, and reconnecting does not restore it.
- The add-email page renders for a Telegram-only account and redirects an
  account with a verified email; markup free of the placeholder, em dashes
  and middots.
- `tests/hq/account-form.test.ts`: `__proto__`, `constructor`, `toString`
  and `hasOwnProperty` are unknown codes, and `["telegram", "__proto__"]`
  renders the generic failure. `tests/hq/migration-order.test.ts`: the
  consent table's columns and the cascading foreign key, applied twice
  through the splitter, and the KEEP classification.
  `tests/hq/capabilities.test.ts` pins the extended vocabulary;
  `tests/hq/member-auth-config.test.ts` preserves the new route.

### Blocked or deferred, task T2.3

- No message is delivered to anyone on Telegram: `hq_telegram_bot_consent`
  is read by the account page only. Delivery, chat ids and the webhook are
  phase 7, and `docs/hq/manual-setup.md` says so.
- The recovery-email page is offered to Telegram-only accounts only.
  `confirmEmailChange` and the endpoints also let an email account change
  its login address (with the notice to the old one), which is what the
  notification rule exists for, but no page links to that; whether to offer
  Change email to email accounts is a product decision.
- The library's non-enumerating branch means a person who asks for an
  address that belongs to another account sees Code sent and never receives
  one. The copy does not explain that, by design.
- Not verified in a browser: the client flow (`requestEmailChange`,
  `changeEmail`, the refreshed cookie, `router.refresh()`) is exercised
  through the endpoints and actions only.

### Changed interfaces, task T2.3

`lib/hq/telegram-identity-plugin.ts`: `TelegramIntent` is `"link" | "unlink"
| "change-email"`; `recordTelegramIntent(store, userId, intent, subject?)`;
new `normalizeEmailAddress(value)`; `/change-email` in both guard lists.
`lib/hq/actions/telegram.ts` exports `confirmEmailChange(newEmail)`,
`setBotMessaging(enabled)` and the types `EmailChangeConfirmationCode`,
`EmailChangeConfirmation`, `BotMessagingResult`. New
`lib/hq/telegram-consent.ts` exports `getBotConsent`, `setBotConsent`,
`revokeBotConsent`, `BotConsent`, `TelegramNotConnectedError`.
`lib/hq/audit-sql.ts`: `bot.consent_changed`. `app/hq/(member)/telegram-copy.ts`
knows three more codes; new `app/hq/(member)/account/email-copy.ts` exports
`emailChangeErrorMessage(error, fallback)` and `EndpointError`. Routes:
`/hq/account/add-email`. Migration: the additive `hq_telegram_bot_consent`
in `builder-schema.sql`.

### External configuration still required, task T2.3

Nothing new. `RESEND_API_KEY` and `EMAIL_FROM` now also carry the
recovery-email code and the change notice; see `docs/hq/manual-setup.md`.

### What changed, task T2.4

One member route list, a capability-driven member menu, and the captain
page. No migration.

New `lib/hq/member-routes.ts` (pure, client-safe: it is bundled for the
browser through `member-auth-config.ts` and the sign-in form):
`MEMBER_PUBLIC_PATHS` (thirteen entries; an entry ending in `/` names a
subtree whose one remaining segment is an id, so `/hq/team/` and the phase 4
invitation continuation `/hq/invite/`), `isMemberPath(pathname)` and
`safeMemberNext(value)`, moved here with the same behaviour (same-origin
relative paths only, `..` resolved before matching, query kept, fragment
dropped, `/hq/welcome` fallback). `proxy.ts` asks `isMemberPath()` and keeps
only its own two exceptions, the operator login and the retired signup URL;
`lib/hq/member-auth-config.ts` re-exports `safeMemberNext` so the sign-in
surfaces are unchanged. The team segment is now the same `[A-Za-z0-9_-]+`
in both places (project ids are UUIDs; the proxy previously took any
slash-free segment).

New `lib/hq/member-nav.ts` (pure): `NavItem { key, label, href,
activeUnder? }`, `getMemberNav({ capabilities, hasTelegram, teamCount })`
and `isNavItemCurrent(item, pathname)`. Home goes to `/hq/dashboard`;
Register team to `/hq/initialize` until the account has a team, then My
teams to `/hq/dashboard` with the team pages as its section; Captain to
`/hq/captain` with the capability only; Connect Telegram to `/hq/account`
while no Telegram identity is linked (a call to action, never current);
Account to `/hq/account`. Exactly one item is current on every member page.

New `components/hq/builder-nav.tsx` (client): `MemberNavProvider`,
`BuilderNav` (`usePathname`, `aria-current`, a list inside
`<nav aria-label="HQ navigation">`) and `BuilderAccount` (the name and the
Sign out control). `components/hq/builder-shell.tsx` renders both in the
header; `back` is opt-in now and renders above the content; `wide` is
unchanged. `BuilderSignOut` takes a `className`. The header wraps: below
960px the menu drops onto its own wrapping row, the operator chrome's
pattern, the account name ellipsises at 40vw, and nothing scrolls sideways
at 400px.

New `app/hq/(member)/layout.tsx`, NOT the auth boundary: it reads the
request-cached `currentActor()` and the account's team count, derives the
menu and hands it to the provider; null for a visitor or an operator
session. A provider rather than a shell in the layout because layouts
cannot pass data to their children and cannot read the pathname (installed
`layout.md`, "Fetching Data" and "Pathname"); every page keeps composing
`BuilderShell` with its own `back`, and the pre-auth screens render no
shell, so they carry no menu. `actor.telegram` is the same identity-row
read `getLoginMethods()` makes, so the layout does not call
`getLoginMethods()`, which would add the user-row and profile reads for
nothing the menu shows. It imports nothing operator-side.

New `/hq/captain` (`captain/page.tsx` with its `loading.tsx`):
`requireMemberActor()`, then `capabilities.has("captain")` from the grants
read for this request, `notFound()` otherwise; "No assignments yet.
Assignments appear here once an admin assigns you a team."; the Connect
Telegram hint without a Telegram identity. Phase 4 fills it.

`app/hq/(member)/dashboard/page.tsx`: `requireMemberActor`, a Connect
Telegram card pointing at `/hq/account` for an account without a Telegram
identity (a Telegram-only account always has one), sign-out moved to the
shell, no Back (Home covers it). The account page and its skeleton lose
their Back for the same reason; the team page states its Back to the
dashboard. `/hq/signin` was already accurate per method from
`getMemberAuthAvailability()` since task T2.1 (`unavailableCopy` in
`account-form.tsx`: one line when neither method is configured), verified
by `tests/hq/account-form.test.ts` and unchanged. The admin `(app)` layout,
chrome and preloads are untouched.

### Checks passed, task T2.4

- Baseline 598 tests; after this task 744 in 33 files, `env -u DATABASE_URL
  -u DATABASE_URL_UNPOOLED npm test`. `npx tsc --noEmit` clean. `npm run
  lint`: 0 errors, the same 18 warnings in `public/deck/deck-stage.js`.
  `npm run build` (same env) passes with `/hq/captain` a dynamic route and
  the proxy compiled.
- `tests/hq/member-routes.test.ts` (95): the list names every member page
  once and nothing operator-side; every member page and the team and
  invitation subtrees pass the proxy without a cookie and survive
  `safeMemberNext` unchanged; every operator page bounces to `/hq/login`
  and falls back to `/hq/welcome`; `/hq/login` and `/hq/signup` pass the
  gate and are never destinations; neither `proxy.ts` nor
  `member-auth-config.ts` carries a route literal of its own and the
  re-export is the same function; `/hq/captain`, `/hq/account`,
  `/hq/invite/abc` accepted; `//evil`, `https://evil`, `/hq/../..`,
  `/hq/%61dmin`, a backslash, control characters and `javascript:`
  rejected.
- `tests/hq/member-nav.test.ts` (14): the capability sets from the brief
  plus a captain without a team; Captain from the capability only, never
  from a team or a link; every href is a member path and no label or href
  is operator-side; one current item per member page; `BuilderNav` markup
  with a single `aria-current`; `BuilderAccount` with the name and Sign
  out; nothing without a provider; the shell with and without Back and
  without the old "My HQ".
- `tests/hq/member-shell.test.ts` (18): a static import scan of the layout,
  the two pure modules and every `builder-*.tsx` (except
  `builder-admin.tsx`, the operator's panel, which is forbidden as an
  import instead) against queries, builder-admin-queries, auth, session,
  hackathon, db, authz, chrome, toast, ui and every operator action module;
  the pure modules carry no `server-only`, no `process.env` and no runtime
  library import; the shell is a server component and the nav a client
  one; the captain page is not found without the grant even with Telegram
  linked, shows the empty state and the hint with it, and drops the hint
  once linked; the dashboard card is present and absent by identity and
  the page body carries no Sign out; the layout derives the menu from the
  actor and the team count and provides nothing for a visitor or an
  operator session.
- `tests/hq/navigation-loading.test.ts` and `tests/hq/auth-boundary.test.ts`
  pass with the new page; `tests/hq/member-auth-config.test.ts` unchanged
  and passing through the re-export; `tests/hq/member-actions-authz.test.ts`
  renders the team page through the new shell and passes.

### Blocked or deferred, task T2.4

- Not verified in a browser: the 960px wrap and the 400px header rest on
  the CSS and the render tests.
- Connect Telegram, in the menu and on the dashboard, follows the identity
  rule the plan states. When Telegram sign-in is not configured both lead
  to the account page's honest "Telegram sign-in is not available yet."
  Hiding them until it is configured is a product decision.
- Register team goes to `/hq/initialize`, the import flow for the current
  edition, as the brief says; the dashboard's own call to action still goes
  through `/hq/welcome` (edition choice, import or invite code).
- `docs/hq/contracts.md` still says a member route is added "in two places,
  until task T2.4", and its module map spells the derivation
  `getMemberNav(actor)`; both are behind this task and belong to the T2.6
  documentation pass.
- Entering the member group from outside renders the layout's actor read
  before a page's `loading.tsx` can show, the trade-off `(app)/layout.tsx`
  already makes; navigating between member pages keeps the layout and shows
  the page's skeleton with the menu in it.

### Changed interfaces, task T2.4

`lib/hq/member-routes.ts` exports `MEMBER_PUBLIC_PATHS`, `isMemberPath`,
`safeMemberNext`; `lib/hq/member-auth-config.ts` re-exports
`safeMemberNext`. `lib/hq/member-nav.ts` exports `NavItem`,
`MemberNavInput`, `getMemberNav`, `isNavItemCurrent`.
`components/hq/builder-nav.tsx` exports `MemberNavState`,
`MemberNavProvider`, `BuilderNav`, `BuilderAccount`.
`BuilderShell({ children, wide?, back? })`: `back` no longer defaults to
the dashboard. `BuilderSignOut({ className? })`. Routes: `/hq/captain`;
`/hq/invite/<token>` is an accepted destination with no page yet (phase 4).
No migration.

### External configuration still required, task T2.4

Nothing new.

### T2.5 review, rate limits and session cookies for both sign-in methods

The plan line "Review rate limits and secure session-cookie behavior for
both methods", one ruling per item, with the evidence in the installed
library (Better Auth 1.7.2 under `node_modules/better-auth/dist`, its core
under `node_modules/@better-auth/core/dist`, better-call under
`node_modules/better-call/dist`; line numbers are those files') and the
test that pins each ruling. Every Change is implemented in this task. No
limit was weakened.

- **(a) Client address from `x-real-ip` only. Keep, documented.** `getIP`
  walks only `advanced.ipAddress.ipAddressHeaders` (core `utils/ip.mjs:201-217`),
  takes a single valid IPv4 or IPv6 value (`:172-192`; a comma chain is
  refused without `trustedProxies`, `:188`) and normalises IPv6 to its /64
  (`:98-104`). Without a usable header it returns null in production, on
  which the limiter keys every such request on one shared per-path bucket
  and warns once (`api/rate-limiter/index.mjs:232-245`): throttled together,
  never bypassed. In test and development it answers 127.0.0.1
  (`ip.mjs:215`). Vercel sets `x-real-ip`, "identical to `x-forwarded-for`",
  from the connection and overwrites a client-supplied value "to prevent
  IP spoofing" (vercel.com/docs/headers/request-headers, read 2026-09-14).
  The assumption now sits in the option's comment: the app is served by
  Vercel directly; behind any other proxy the limits would key on that
  proxy's address until its `trustedProxies` are configured. Test: "reads
  the client address from x-real-ip alone" in `tests/hq/member-auth.test.ts`.

- **(b) `Secure` attribute against the `__Secure-` prefix. Change.** The
  prefix follows the baseURL scheme (`cookies/index.mjs:23`); the attribute
  defaults to the prefix (`:34`) but is overridden by
  `defaultCookieAttributes` (`:39`), which the repo set to `NODE_ENV ===
  "production"`. On the wire the mismatch was latent: better-call forces
  `Secure` onto any name starting with `__Secure-` (`cookies.mjs:47`), which
  is why the test harness (NODE_ENV test, https origin) already emitted a
  correct line. Not a property to lean on in a transitive dependency. Now
  `memberAuthUsesSecureCookies()` (`lib/hq/member-auth-config.ts`) is true
  exactly when `memberAuthOrigin()` is https, and that one boolean sets both
  `advanced.useSecureCookies` (the prefix) and `defaultCookieAttributes.secure`.
  Plain http is only ever localhost outside production, where a browser
  drops a Secure cookie. Tests: the pure rule in
  `tests/hq/member-auth-config.test.ts`; the actual Set-Cookie line, with
  NODE_ENV asserted not production, on the email sign-in
  (`member-auth.test.ts`) and on the Telegram callback and the signed state
  cookie (`member-auth-telegram.test.ts`), each matched whole:
  `__Secure-stnl_builder.session_token=...; Max-Age=2592000; Path=/;
  HttpOnly; Secure; SameSite=Lax` and the state cookie with `Max-Age=300`.

- **(c) Session 30 days, `updateAge` one day, cookie cache off. Keep.**
  `expiresIn` is the cookie Max-Age (`cookies/index.mjs:49`) and the row's
  expiry; a request more than `updateAge` after the last refresh extends
  both by another 30 days (`api/routes/session.mjs:171-208`), so an inactive
  account is signed out after 30 days and an active one stays in. The
  actions that change how one signs in sit behind the identity plugin's
  15-minute window on the session's `createdAt`, which the refresh never
  touches (task T2.2), so the rolling session does not extend the sensitive
  window. With the cookie cache off every request reads the session row, so
  a deleted session (unlink, `redirectToMemberSignIn`, a missing identity
  row) is gone on the next request; the cost is one indexed read per
  request. No "remember me" choice is offered, so the Max-Age is always
  set.

- **(d) Rate limits. Keep every rule; Change the surface.** Precedence
  (`api/rate-limiter/index.mjs:246-276`): a repo custom rule replaces a
  plugin rule, which replaces the library's default special rule
  (`:302-315`); otherwise the repo's 60 per 60 s. Effective, per client
  address and path: `/sign-in/social` 3 per 10 s (default);
  `/callback/telegram` 10 per 60 s (identity plugin; plugin matchers see the
  request path, `:236,252`); `/email-otp/send-verification-otp` 3 per 60 s
  (default, plugin and repo agree); `/sign-in/email-otp` 5 per 60 s (repo,
  over the plugin's 3 per 60 s and the default's 3 per 10 s: room for a
  mistyped code and a resend within the minute, while the code's own
  three-attempt budget bounds guessing, `plugins/email-otp/routes.mjs:764-783`);
  `/email-otp/request-email-change` and `/email-otp/change-email` 3 per 60 s
  (emailOTP plugin, `email-otp/index.mjs:125-138`); the core `/change-email`
  3 per 10 s (default) and disabled by option; `/link-social`,
  `/unlink-account`, `/get-session`, `/sign-out` and the rest 60 per 60 s,
  all behind a session and, for the first two, the recency window and a
  confirmed intent. The limiter runs in `onRequest` before any handler
  (`api/index.mjs:168`) as one atomic database step (`rate-limiter/index.mjs:91-170`
  on `hq_auth_rate_limit`, whose `key` is unique); the four-path budget
  test in `member-auth.test.ts` pins the first four rules above and that a
  second address is a separate budget. `/callback/telegram` cannot be used
  to brute-force `state`: the value is 32 characters from a 64-symbol
  alphabet (`state.mjs:55`, `crypto/random.mjs:3`), must exist as a
  verification row (`state.mjs:120`), must equal the signed
  `stnl_builder.state` cookie of the same browser (`:131-137`;
  `skipStateCookieCheck` false, `context/create-context.mjs:137`), is
  consumed on first use (`:139`) and expires after ten minutes (`:141`),
  all before the code exchange (`api/routes/callback.mjs:79` against
  `:110`), so a guess costs Telegram nothing and the 10 per minute rule
  bounds even that (test "rate-limits the Telegram callback per IP without
  touching Telegram"). Changes: the emailOTP endpoints HQ never calls join
  `disabledPaths`, answering 404 before the limiter and every hook
  (`api/index.mjs:164-166`): `/email-otp/check-verification-otp` (verifies
  a sign-in code without consuming it and counts attempts with a read then
  a write, `routes.mjs:222-263`, a second guesser next to the atomic one),
  `/email-otp/verify-email`, `/email-otp/request-password-reset`,
  `/forget-password/email-otp` and `/email-otp/reset-password` (HQ has no
  password; the reset routes mail a known address and answer an unknown
  one at once, `routes.mjs:464-568`). The custom 5 per 60 s rule for the
  now disabled `/email-otp/verify-email` is gone; should the path ever
  return, the plugin's stricter 3 per 60 s applies. Test: "keeps the code
  endpoints HQ does not use disabled, ahead of the rate limiter".

- **(e) `HttpOnly` and `SameSite` on the session cookie. Keep.** Both are
  the library's defaults (`cookies/index.mjs:35-37`), restated by the repo,
  and serialised as `HttpOnly; SameSite=Lax` (better-call
  `cookies.mjs:63-65`). Lax is required: the return from Telegram is a
  top-level GET redirect that must carry the signed state cookie and, for a
  link, the session; Strict would drop both. Cross-site POSTs are stopped by
  the origin check (`disableOriginCheck` and `disableCSRFCheck` false; test
  "rejects cross-origin mutation" in `member-auth.test.ts`). Verified on
  the wire for both methods by the tests under (b).

- **(f) Non-enumerating code requests. Keep for sign-in; Change the other
  types.** For `type: "sign-in"` the library sends a code whether or not
  the address has an account (`routes.mjs:103-110`), and both branches
  await the same send (`runInBackgroundOrAwait` awaits when no background
  handler is configured, `context/create-context.mjs:214-224`), so status,
  body, timing and the mail are the same. Test: "answers a sign-in code
  request for a known address exactly like one for an unknown address, and
  serves no other code type". For `email-verification` and
  `forget-password` the same endpoint mails a known address and answers an
  unknown one at once without a mail (`routes.mjs:104-107`): a timing tell,
  and a way for anyone to mail a member a code. An options-level before
  hook now refuses every type but `sign-in` with 400 `INVALID_OTP_TYPE`
  before any lookup; the client only ever sends `sign-in`
  (`app/hq/(member)/account-form.tsx`).

- **Carried from the T2.3 review: the `/email-otp/change-email` attempt
  budget as an oracle. Change; the timing residue accepted.** The request
  route stores a code for a free address and deletes it for a taken one
  (`routes.mjs:666-669`), so the verify route answered `INVALID_OTP`
  forever for a taken address but `TOO_MANY_ATTEMPTS` (403) after three
  guesses and `OTP_EXPIRED` after five minutes for a free one
  (`routes.mjs:764-783`). An options-level after hook now answers every
  failed code on that one route with the library's own 400 `INVALID_OTP`
  body. It returns a Response rather than throwing: the dispatcher keeps
  the handler's status for an error thrown from an after hook
  (`api/dispatch.mjs:231-236,242-244`; better-call `to-response.mjs:125-129`)
  and replaces it only with a Response (`:97-104`). The sign-in route keeps
  its own answers, a code there being no account (test "spends the sign-in
  code's three attempts"). Test: "answers a failed code for an address
  another account holds exactly like one for a free address, whatever the
  attempt or the code's age" compares status, reason phrase, content type
  and body across five guesses and an expired code, and checks the budget
  still kills the right code. The copy for `TOO_MANY_ATTEMPTS` and
  `OTP_EXPIRED` in `email-copy.ts` is unreachable from this route now; the
  `INVALID_OTP` line already says "incorrect or has expired" and offers a
  resend, so no copy change. Accepted, with reasoning: the request route
  still returns at once for a taken address and after the mail send for a
  free one, and the delivery wrapper's honest 503 (task T0.2) can only
  occur for a free address. Closing those would mean padding response
  times or hiding delivery failures. Against them stand a session created
  within 15 minutes, a confirmation step per probed address, 3 requests
  per minute per client address, one bit of low value (whether an address
  has an HQ account), and a probe that mails a stranger one "you can
  ignore this" line, which the public sign-in code endpoint already lets
  anyone do at the same rate. Tighter per-address limits would slow the
  oracle, not close it, and 3 per minute is the tightest rule there is.

### What changed, task T2.5

No migration. `lib/hq/member-auth-config.ts` gained
`memberAuthUsesSecureCookies(env)`. `lib/hq/member-auth.ts`: one
`secureCookies` boolean from it sets `advanced.useSecureCookies` and
`defaultCookieAttributes.secure`; `disabledPaths` gained the five emailOTP
paths named under (d); the custom rule for `/email-otp/verify-email` is
gone; new options-level `hooks.before` (the code-type restriction under
(f)) and `hooks.after` (the change-email normalisation above); comments on
the address header and the rate-limit block record the rulings in place.

### Checks passed, task T2.5

- Baseline 744 tests; after this task 754 in 33 files, `env -u DATABASE_URL
  -u DATABASE_URL_UNPOOLED npm test`. `npx tsc --noEmit` clean. `npm run
  lint`: 0 errors, the same 18 warnings in `public/deck/deck-stage.js`.
  No `app/` file changed, so no build.
- `tests/hq/member-auth-config.test.ts` (+1): the secure-cookie rule for
  https under production, development and test, http localhost, a refused
  http origin and no origin.
- `tests/hq/member-auth.test.ts` (+8, one table of four): the whole
  session Set-Cookie line on email sign-in with NODE_ENV not production;
  the per-address budgets of `/sign-in/social` (3), `/sign-in/email-otp`
  (5), `/email-otp/request-email-change` (3) and `/email-otp/change-email`
  (3), the 429 with `X-Retry-After`, and a second address unaffected;
  `getIP` reading `x-real-ip` alone and refusing a chain; a known and an
  unknown address answered and mailed alike for a sign-in code and the
  other three types refused for both; the five disabled paths answering 404
  with no mail, no row and no rate-limit row; the sign-in code's three
  attempts, then 403 `TOO_MANY_ATTEMPTS` even for the right code.
- `tests/hq/member-auth-telegram.test.ts` (+1, two strengthened): the
  signed state cookie's whole line on `/sign-in/social` and the session
  cookie's on the callback; the change-email oracle test described above.

### Blocked or deferred, task T2.5

- The timing difference on `/email-otp/request-email-change` and the
  delivery-failure 503 for a free address are accepted, not closed (the
  reasoning is in the carried-finding ruling).
- The `TOO_MANY_ATTEMPTS` and `OTP_EXPIRED` entries in
  `app/hq/(member)/account/email-copy.ts` no longer have a route that emits
  them. They are harmless; removing them is copy work outside this task.
- Behind a proxy other than Vercel the address rule under (a) needs
  `trustedProxies`; no such deployment exists.
- Server-side callers of `auth.api.changeEmailEmailOTP` would receive the
  normalised Response instead of a thrown error; HQ has none.

### Changed interfaces, task T2.5

`lib/hq/member-auth-config.ts` exports `memberAuthUsesSecureCookies(env)`.
`/email-otp/send-verification-otp` answers 400 `INVALID_OTP_TYPE` for any
`type` but `sign-in`. `/email-otp/change-email` answers 400 `INVALID_OTP`
for every failed code. `/email-otp/check-verification-otp`,
`/email-otp/verify-email`, `/email-otp/request-password-reset`,
`/forget-password/email-otp` and `/email-otp/reset-password` answer 404.
Cookies on an https origin carry `Secure` and the `__Secure-` prefix
regardless of `NODE_ENV`. No migration.

### External configuration still required, task T2.5

Nothing new. `BETTER_AUTH_URL` now also decides the cookies' `Secure`
attribute; it must stay the https origin (`docs/hq/manual-setup.md`).

### Phase 2 summary and acceptance checklist

Tasks T2.1, T2.2, T2.3, T2.4, T2.5 and T2.6.

**What changed and which migrations apply.** Google and GitHub are gone from
public sign-in. Telegram sign-in is live in code behind its two credentials, with
Connect Telegram and Disconnect Telegram from `/hq/account`, each behind a
confirmation step, a session created within 15 minutes and a single-use intent.
A Telegram-first account can add a verified recovery email, the previous
verified login address is notified without being told the new one, and bot
messaging is a separate, revocable decision that delivers nothing yet. Every
member route lives in one list, the member shell has a capability-driven menu
and an account corner, and `/hq/captain` exists and is not found without the
grant. Rate limits and session-cookie behaviour were reviewed for both methods
with one ruling per item, and every Change in that review is implemented.

Migrations, both additive and both applied by `hq:migrate` in the usual order:
`hq_auth_account_telegram_user_idx`, a partial unique index on
`hq_auth_account("userId") WHERE "providerId" = 'telegram'`, in
`scripts/hq/member-auth-schema.sql` (T2.2); and `CREATE TABLE IF NOT EXISTS
hq_telegram_bot_consent` in `scripts/hq/builder-schema.sql`, classified KEEP in
`scripts/hq/reset-statements.ts` (T2.3). T2.1, T2.4 and T2.5 added no SQL. The
Telegram link confirmation intent is a single-use row in the existing
`hq_auth_verification` table, not a new one.

**Acceptance checklist.** The plan's phase 2 acceptance list and its external
setup rule, quoted verbatim, each with the test that proves it or an explicit
deferral naming the phase that owns it.

1. "Telegram-only, email-only and linked accounts complete signup/login and
   return to the correct destination." Passed.
   - Telegram-only: `tests/hq/member-auth-telegram.test.ts` "completes the
     callback into a verified HQ account that has no email", "signs a returning
     Telegram user into the same account" and "takes a Telegram-first account
     through the name step without asking for an email".
   - Email-only: `tests/hq/member-auth.test.ts` "creates a verified account and
     CRM profile only after a valid email code", "signs an existing user in
     without duplicating accounts or changing their name" and "completes a new
     email-only sign-in profile before creating its Person".
   - Linked: `tests/hq/member-auth-telegram.test.ts` "connects Telegram to an
     email account through the confirmed redirect flow, preserving the account"
     and "adds a verified recovery email to a Telegram-first account, mailing the
     new address once and nobody else", which ends by signing the same account in
     with an email code.
   - The correct destination: `tests/hq/member-routes.test.ts` "names every
     member page once, the team and invitation subtrees included, and nothing
     operator-side", its `it.each` cases "preserves %s" over every member
     destination and "rejects %s" over the open-redirect and traversal attempts,
     and "keeps the query, whatever it carries, and drops the fragment";
     `tests/hq/member-actions-authz.test.ts` "sends a signed-out visitor to sign
     in with the team URL as the destination".
   - Not covered by a test: the browser round trip after `signIn.social`
     follows the library's returned URL. Recorded under "Live checks still
     pending" in `docs/hq/manual-setup.md`.
2. "Connecting Telegram preserves the account, team memberships and Captain
   access." Passed, `tests/hq/member-auth-telegram.test.ts` "connects Telegram to
   an email account through the confirmed redirect flow, preserving the account",
   which asserts the account id, the profile, the enrollment, the capability
   grant and the team row unchanged and exactly one `identity.linked` event. The
   conflict cases that must move nothing: "refuses to connect a Telegram account
   that belongs to another HQ account, moving nothing", "refuses a second
   Telegram for an account, at the endpoint and inside the account transaction"
   and "lets the database refuse a second Telegram account row even when the
   identity backstop cannot see it".
3. "Existing admin accounts continue to sign in with their unchanged usernames
   and passwords; public signup cannot claim or convert an admin account."
   Passed. Admin sign-in: `tests/hq/operator-auth-actions.test.ts`, 14 checks
   over the real Server Actions, including "signs a known operator in, issues the
   session cookie and lands on the picker", "normalises the submitted username
   before the lookup" and "bumps password_version, revokes every live session and
   re-issues one"; nothing under `hq_users` or `lib/hq/actions/auth.ts` changed in
   phases 0 to 2, and `tests/hq/migration-order.test.ts` "keeps operator logins
   and People links, and gives every linked People card its person" proves the
   ids, usernames, password hashes and versions survive the migrations. Neither
   session can be the other: `tests/hq/operator-auth-actions.test.ts` "does not
   accept a live public member cookie as an operator session" and
   `tests/hq/member-auth.test.ts` "rejects cross-origin mutation and does not
   accept the operator cookie as a public session". No public path reaches an
   operator record: `tests/hq/authz.test.ts` "requireOperatorActor and
   requireOperator wrap requireUser and never admit a member session" and
   `tests/hq/auth-boundary.test.ts` "maps every action module to a gate, and only
   existing modules".
4. "A failed or expired login/link attempt grants no roles and consumes no
   Captain invitation use." Passed for the login and link halves; the invitation
   half is deferred.
   - A failed or expired login: `tests/hq/member-auth-telegram.test.ts` "refuses
     replayed, unbound, forged and stale callbacks", "never accepts a
     client-supplied id_token, with each fence sufficient on its own" and
     "refuses a Telegram identity another account already holds, before any row
     is committed"; `tests/hq/member-auth.test.ts` "rejects incorrect and expired
     codes without populating People" and "spends the sign-in code's three
     attempts and then refuses even the right code".
   - A failed or expired link: `tests/hq/member-auth-telegram.test.ts` "refuses a
     link whose confirmation is missing, expired, for the other action or already
     used, and a failed link grants nothing", "requires a session created within
     15 minutes on every endpoint that adds or removes a login method", "stays
     stale through the library's own session refresh" and "lets a stale session
     neither add an email nor use one to disconnect Telegram".
   - **"Consumes no Captain invitation use" is deferred to phase 4.** No
     invitation table, token, landing page or redemption path exists in the
     checkout, so there is nothing an attempt could consume and nothing to
     assert. Phase 4 creates them and owns this half of the bullet.
5. "Bot messaging is optional and is accurately reflected in connection status."
   Passed for the decision and the status; delivery is deferred.
   `tests/hq/member-auth-telegram.test.ts` "keeps bot messages a separate
   decision from the Telegram connection, and declining changes nothing about
   access" covers the separation, the Disabled default, enabling and disabling
   through the action with the `bot.consent_changed` events, a repeat recording
   nothing, `currentMember()` and `requireMember()` unchanged after declining, an
   email-only account refused with `TELEGRAM_NOT_CONNECTED` and no Bot messages
   section at all. The test "revokes bot messages when Telegram is disconnected,
   in the same operation" covers the status staying accurate when the connection
   goes,
   and that reconnecting does not restore it. The page renders from server data
   only: "renders the account page from server data only, and ends a session
   whose identity row is missing". **Delivery is deferred to phase 7**: nothing
   reads `hq_telegram_bot_consent` to send a message, no chat id is stored, no
   webhook exists, and no test claims otherwise.
6. "Google/GitHub are absent from the final public auth flow; operator login
   still works." Passed. `tests/hq/member-auth.test.ts` "no longer offers google
   sign-in, whatever the environment holds" and "no longer offers github sign-in,
   whatever the environment holds" (one `it.each` over the two providers) stub
   all four credential variables and get 404 `PROVIDER_NOT_FOUND` from
   `/api/auth/sign-in/social`. `tests/hq/member-auth-config.test.ts` "reports
   exactly the configured, email and telegram flags" and "gives the removed
   Google and GitHub credentials no effect" pin the availability shape.
   `tests/hq/account-form.test.ts` "offers Telegram first and email second, with
   nothing left of the removed providers" pins the markup. Operator login still
   works: `tests/hq/operator-auth-actions.test.ts`, passing unchanged. **Owner
   action outstanding:** delete `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from the Vercel project. Nothing
   reads them, so leaving them set changes no behaviour.
7. External setup rule: "Unconfigured public login methods should show an
   accurate unavailable state without affecting existing admin login." Passed.
   `tests/hq/account-form.test.ts` "says which method is unavailable and points
   at the other, per mode" and "collapses to one honest line when neither method
   is configured"; `tests/hq/member-auth-config.test.ts` "does not advertise
   email sign-in without both an API key and a sender" and "advertises Telegram
   only with both login credentials, whatever the bot username";
   `tests/hq/member-auth-telegram.test.ts` "keeps email sign-in and existing
   sessions working while Telegram is unreachable", which also fails the suite on
   any request to the discovery document. Admin login is untouched:
   `tests/hq/operator-auth-actions.test.ts`. **One gap, unchanged since task
   T0.2:** the 503 `AUTH_UNAVAILABLE` response in
   `app/api/auth/[...all]/route.ts` has no test of its own. It is recorded as a
   gap in `docs/hq/manual-setup.md` rather than claimed as covered.
8. External setup rule: "It must not invent credentials, DNS records, verified
   domains or successful live tests." Held, and not a test. Resend and Telegram
   are recorded "Not configured" in `docs/hq/manual-setup.md`; every check that
   needs the owner's accounts sits in a separate "Live checks still pending"
   group and none of them is reported as done; no credential, DNS record, domain
   or endpoint secret appears anywhere in this repository; and the World's Fair
   external Colosseum id and slug are recorded as unverified owner input rather
   than guessed.

**Contract gate items beyond the plan's list.**

- "Both member route allowlists come from one source":
  `tests/hq/member-routes.test.ts` "is the same list in both places: neither file
  keeps a route list of its own", with its `it.each` pairs "both let a member
  reach %s" and "both keep a member off %s".
- The capability-driven shell: `tests/hq/member-nav.test.ts` "Captain appears
  with the capability only, never from a team or a Telegram link", "email-only
  account with no teams: Home, Register team, Connect Telegram, Account",
  "Telegram-only account with teams: Home, My teams, Account", "captain who is
  also a team member sees both modules together", "marks exactly one derived item
  current on each member page" and "never links anywhere operator-side, and every
  target is a member route"; `tests/hq/member-shell.test.ts` "is not found
  without the capability, whatever else the account holds", "derives the menu and
  the account corner from the actor and the team count, for the shell a page
  renders" and "renders no menu for a visitor, and none for an operator session,
  which is not a member".
- The admin application stays separate: `tests/hq/member-shell.test.ts` "scans
  the layout, the two pure modules and every builder component" (a static import
  scan against the operator queries, session, chrome, UI and every operator
  action module) and "keeps the two pure modules client-safe: no server-only, no
  environment, no runtime import of a server module".
- "The rate limit and cookie review is recorded with outcomes": the "T2.5 review"
  section above, one ruling per item. The rulings are pinned by
  `tests/hq/member-auth-config.test.ts` "marks cookies Secure exactly when the
  origin is https, whatever NODE_ENV says"; `tests/hq/member-auth.test.ts` "reads
  the client address from x-real-ip alone, and only when it is a single address",
  "rate-limits code sends across requests using the database", "keeps the code
  endpoints HQ does not use disabled, ahead of the rate limiter", "answers a
  sign-in code request for a known address exactly like one for an unknown
  address, and serves no other code type" and "spends the sign-in code's three
  attempts and then refuses even the right code"; and
  `tests/hq/member-auth-telegram.test.ts` "rate-limits the Telegram callback per
  IP without touching Telegram", "answers a request for an address another
  account holds exactly like one for a free address, sending nothing to it",
  "answers a failed code for an address another account holds exactly like one
  for a free address, whatever the attempt or the code's age", "does not expose
  the stored provider tokens to the session holder", "keeps the core change-email
  route disabled" and "keeps the core delete-user route disabled".

**Blocked or deferred out of phase 2, with the phase that owns each.**

- "Consumes no Captain invitation use", and the `/hq/invite/<token>` destination
  that the route list already accepts with no page behind it: **phase 4**.
- Bot message delivery, chat ids, the webhook and revocation as a bot request
  sees it: **phase 7**.
- The `/hq/captain` assignment list, which shows "No assignments yet" today:
  **phase 4**.
- Whether to offer Change email to accounts that already sign in with email: a
  product decision, not a phase. The action and the endpoints support it; no page
  links to it.
- Whether to hide Connect Telegram entirely while Telegram sign-in is
  unconfigured, rather than leading to the honest unavailable line: a product
  decision, not a phase.
- Accepted rather than closed, with the reasoning in the T2.5 review: the timing
  difference on `/email-otp/request-email-change` between a free and a taken
  address, and the honest 503 that a delivery failure can only produce for a free
  address.
- Not verified in a browser, and therefore owner checks: the client flows
  (`signIn.social`, `linkSocial`, `unlinkAccount`, `requestEmailChange`,
  `changeEmail`, the refreshed cookie), the 960px header wrap and the 400px
  layout. All three are in `docs/hq/manual-setup.md`.
- Behind a proxy other than Vercel the client-address rule needs
  `trustedProxies`. No such deployment exists.
- `TOO_MANY_ATTEMPTS` and `OTP_EXPIRED` in
  `app/hq/(member)/account/email-copy.ts` no longer have a route that emits them.
  Harmless copy, outside the task.

**Changed interfaces later phases use.** The full per-task lists are above. The
phase 3 shortlist, with the fallback asset path, the unverified Colosseum
edition, the fixtures and four notes phase 3 must not rediscover, is in
`docs/hq/contracts.md` under "Handoff to phase 3".

**External configuration still required, names only.**

- Not configured, and public sign-in stays unavailable until they are set:
  `RESEND_API_KEY` and `EMAIL_FROM` (email sign-in, the recovery-email code and
  the change notice); `TELEGRAM_LOGIN_CLIENT_ID` and
  `TELEGRAM_LOGIN_CLIENT_SECRET` (Telegram sign-in and Connect Telegram).
  `TELEGRAM_BOT_USERNAME` is copy only and gates nothing.
- State unknown from a checkout, so treat as unconfirmed: `BETTER_AUTH_URL` and
  `BETTER_AUTH_SECRET`. Since task T2.5, `BETTER_AUTH_URL` also decides the
  `Secure` attribute and the `__Secure-` cookie prefix, so it must be the https
  production origin.
- Phase 7 only: `TELEGRAM_BOT_TOKEN`, plus the webhook URL registered with
  Telegram.
- To delete if set: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.
- Not an environment variable: the Colosseum external edition id and slug. Typed
  into Admin, stored in `hq_hackathon_onboarding`, never seeded and never hard
  coded.

Who does what, in dependency order, is in `docs/hq/manual-setup.md`.

### Verification run for phases 0 to 2, task T2.6

Run on branch `hq-captains-phases-0-2` at commit `c9667e3`, before this
documentation commit. Counts, not logs.

- `npm run lint`: 0 errors, 18 warnings, all pre-existing and all in
  `public/deck/deck-stage.js`. Unchanged from the phase 0 baseline.
- `npx tsc --noEmit`: clean, no output.
- `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`: 754 tests in 33 files,
  all passing. The phase 0 baseline was 421.
- `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm run build`: passes. Every
  `/hq` route compiles, `/hq/captain`, `/hq/account`, `/hq/account/add-email`,
  `/hq/account/connect-telegram` and `/hq/account/disconnect-telegram` are listed
  as dynamic, and the proxy compiles as middleware. No environment variable was
  needed for the build.

The two `env -u` flags matter for the same reason they did at the baseline: an
exported `DATABASE_URL` can reach an unmocked `getSql()` during a run.
`vitest.config.mts` blanks both for every test as well, so the flags are now belt
and braces rather than the only guard.

## Carried over before phase 4: the navigation fix and the whole-branch review

Two things landed on this branch before phase 4's own tasks. Neither is a phase
deliverable and neither has its own plan section, so they are recorded here
rather than left only in the session ledger.

### T-FIX: the member navigation no longer loads every team to count them

The plan's own "fix first, before new work" item, and independently the
whole-branch review's Important 3 (below). `lib/hq/builder-store.ts` gained a
shared `OWN_TEAM` predicate constant (the ownership check `teams()` already
used inline) and a new `hasTeams(userId): Promise<boolean>`
(`SELECT EXISTS(SELECT 1 FROM hq_project_onboarding o WHERE ${OWN_TEAM})`; no
team row is selected, no roster aggregated). `app/hq/(member)/layout.tsx#memberNavState()`
calls it instead of `(await builderStore().teams(actor.id)).length`.
`getMemberNav`'s `teamCount: number` became `hasTeams: boolean` in
`lib/hq/member-nav.ts`, because the nav only ever asked "greater than zero"
and a boolean is the honest shape for that question rather than a count that
no longer counts anything. `docs/hq/contracts.md` was updated in the same
commit (the "Shell and navigation" module-map row and the "Shell and routes"
bullet), so it never carried the stale signature.

**Checks passed:** new `tests/hq/builder-store-has-teams.test.ts` (PGlite,
real migrated schema) compares `hasTeams(userId)` against `teams(userId)` on
every membership shape side by side — no relationship at all (`false`/`[]`,
including when other accounts have teams); owner of a verified claim; owner of
a pending claim and, separately, a rejected one (`it.each`, both
`true`/`[project]` — the dashboard shows both, so the menu must say "My
teams"); an unclaimed roster row (`false`, an invite not yet redeemed), the
same row once joined (`true`), then once released (`false` again).
`tests/hq/member-shell.test.ts` extended: the layout test now asserts
`hasTeams` was called with the actor id **and `teams` was not called at
all**. `tests/hq/member-nav.test.ts`: every `teamCount: N` became
`hasTeams: true|false`, rule table otherwise unchanged. Full suite at this
commit: 760 tests in 34 files, `tsc` clean, lint unchanged (0 errors, 18
pre-existing warnings, verified against a `git stash` of the change).

**Blocked or deferred:** none. `teams()` was deliberately not wrapped in
`cache()` (the dashboard is now the only caller left in a member request, so
there is nothing left to dedupe).

**Changed interfaces:** `BuilderStore.hasTeams(userId)` in
`lib/hq/builder-store.ts`; `getMemberNav({ capabilities, hasTelegram,
hasTeams })` in `lib/hq/member-nav.ts` (`MemberNavInput.hasTeams: boolean`,
replacing `teamCount: number`).

**External configuration:** None added.

Commit `dd361ac`. Review: 0 Critical, 0 Important. The reviewer confirmed the
agreement between `hasTeams()` and `teams()` is structurally guaranteed by the
shared `OWN_TEAM` predicate plus the `hq_project_onboarding` foreign keys
(`ON DELETE CASCADE` from both `hq_projects` and `hq_hackathons`), not merely
tested. Two accepted minors, neither actioned: the layout's "no longer calls
`teams()`" assertion is mock-level, paired with the PGlite behavioural test
rather than duplicating it; two stale `teamCount` mentions remain in the
untracked plan file's own history and in the historical T2.4 log entry above,
left as history rather than rewritten.

### Whole-branch review of phases 0-2 (`bcba7df..29203e7`)

Deferred from the previous session for a usage-limit reason, run at the start
of this one. Full report:
`.superpowers/sdd/2026-09-13-hq-captains-and-colosseum/final-review-report.md`.
Reviewed read-only, in three passes (the plan and the docs; the identity,
authorization, capability, audit, CRM and migration modules; the member and
operator surfaces, the tests, and the doc-to-code claims), plus one targeted
static analysis of the import graph and one of the SQL splitter.

**Verdict: 0 Critical, 6 Important, 16 Minor, "ready to merge with fixes".**
Strengths recorded: the authorization core's non-enumeration property is
"thought through to an unusual depth"; the two session origins (`operator` and
`member`) stay genuinely separate with no path between them; the Telegram
identity model is defended by four independent mechanisms; the migrations are
"the strongest part of the branch" (idempotent, tested through the real
splitter, twice fresh and three or four times over a populated fixture); every
test the reviewer sampled asserts real behaviour rather than a mock, and seven
of the test names the implementation log cited as acceptance proof were
spot-checked and found to exist exactly where cited.

The six Important findings, all fixed by task REVFIX below before phase 4
began:

- **I1.** `confirmEmailChange` had no check for an account that already has a
  login email. Only the page (`app/hq/(member)/account/add-email/page.tsx`)
  redirected such an account away; the Server Action itself did not refuse
  it, so a fresh session (created within the 15-minute recency window) could
  permanently move an existing email account's login address, then disconnect
  Telegram, locking the real owner out with only a notice to the old address
  that deliberately does not name the new one.
- **I2.** the Telegram placeholder address
  (`<sub>@telegram.placeholder.invalid`) reached a browser through
  `/api/auth/get-session`, because no `customSession` transform existed —
  contradicting the plan's own stated contract that the placeholder "never
  reaches a browser, a contact field or a mail sender". Not a cross-user leak
  (it is the account's own subject), but a future `useSession()` call in any
  client component would have surfaced it.
- **I3.** the member layout query the T-FIX task above already closed; the
  reviewer reached the same diagnosis and the same fix (an existence check,
  the `hasTeams` shape) independently, in the same session, before T-FIX's
  commit landed.
- **I4.** `grantCapability`/`revokeCapability` could only attribute a change
  to an operator (`actorOperatorId: string`), with the audit event
  hard-coding `actor: { kind: "operator", ... }`. That cannot express a
  member redeeming their own Captain invitation — phase 4's first new caller
  — and would have recorded an operator action that never happened.
- **I5.** `listCapabilityGrants` and `listAuditEvents` were ungated readers
  carrying the admin's free-text grant reason and both operator ids, with no
  narrowed view model for a member-visible surface to use instead. Not
  exploitable at the time (every caller was operator-gated), but phase 4's
  Captain leaderboard is exactly the first member-facing caller the review
  anticipated.
- **I6.** every operator Server Action module transitively imported the whole
  public member-auth graph (`lib/hq/actions/*.ts → actions/util.ts →
  authz.ts → actor.ts → member-auth.ts`), pulling `better-auth`,
  `@better-auth/core`, `resend` and `jose` into operator route bundles that
  none of them use. Walking the graph from `lib/hq/actions/projects.ts`
  reached 31 modules; phase 4's `lib/hq/actions/captains.ts` would have
  inherited the coupling.

Three Minors were promoted alongside the six Importants because phase 4 would
make each more expensive to fix later: **M1** (`isPlaceholderEmail` credited
to the wrong module in `docs/hq/contracts.md`'s "Handoff to phase 3" section),
**M2** (`updateTeam`'s SQL predicate, `verification <> 'rejected'`, looser
than the `verification = 'verified'` decision that gates it), **M3**
(`toPublicPersonView` included the Captain capability label by default
instead of on request — the mapper had no app caller yet, so the signature
was free to change). The remaining thirteen Minors and the "agreed, can stay
deferred" list are recorded in the review report; none blocks phase 4 and none
is repeated here.

### REVFIX: the review's fix wave

Nine commits, `dd361ac..9093467`, one per finding plus a self-review commit
(`9093467`). 781 tests in 35 files passing, `tsc` clean, lint unchanged (0
errors, 18 pre-existing warnings), `npm run build` passing. Independently
re-reviewed afterwards and confirmed: all ten findings addressed at the
defect rather than worked around, all four implementer concerns judged sound,
no new Critical or Important issue.

- **I1 fixed.** `lib/hq/actions/telegram.ts#confirmEmailChange` now answers
  `{ ok: false, code: "EMAIL_ALREADY_SET" }` when `actor.email !== null`,
  before it looks at the address, the session or the intent — the same rule
  the page already enforced, now at the boundary. One consequence recorded:
  the `user.update.after` notice to a previous verified address is now
  reachable only by writing the change-email intent directly (there is no
  product flow that can trigger it), which is defence for a feature HQ does
  not currently offer.
- **I2 fixed.** `lib/hq/member-auth.ts` gained a `customSession` transform
  mapping a placeholder `user.email` to `null` and `emailVerified` to
  `false`, built on the existing `isPlaceholderEmail` rather than a fourth
  copy of the rule. Because the plugin's `/get-session` endpoint replaces the
  core one in `auth.api` too, the transform applies to **every** server
  reader of a member session, not only the HTTP route —
  `currentMemberSession()` now returns the transformed shape, and
  `StoredAccount.email` is `string | null` for that reason: a string as
  Better Auth hands a row to a database hook, `null` once a session reads it
  back. `isVerifiedAccount`, `verifiedLoginEmail` and
  `telegramIsLastLoginMethod` all handle both without behaviour change.
- **I3** already fixed by T-FIX; left untouched here.
- **I4 fixed.** `CapabilityChange` is now `{ actor: AuditActor; byOperatorId:
  string | null; userId; capability; reason }`. `actor` goes straight to
  `recordAuditEvent`; `byOperatorId` binds `granted_by_user_id` (on a grant)
  or `revoked_by_user_id` (on a revocation), or `null`. `revokeCapability` was
  widened the same way, symmetrically — an asymmetric pair would have been a
  trap for phase 4's revocation cascade, which needed exactly this shape.
- **I5 fixed.** `lib/hq/view-models.ts` gained `CaptainLeaderboardView =
  { rank, displayName, assignedCount }` (T4.5 later added `isYou`), with a
  doc comment naming every field the admin-only `CapabilityGrant`/
  `AuditEvent` shapes carry that this view model deliberately omits.
  `listCapabilityGrants`/`listAuditEvents` were **not** given an actor
  parameter — gating `audit.ts` would create the cycle `member-auth.ts →
  audit.ts → actor.ts → member-auth.ts`, and gating `capabilities.ts` through
  `authz.ts` or `actor.ts` would partly undo I6 for every caller of
  `listActiveCapabilities`. The narrowed view model plus the contracts note
  is the boundary instead, and both function doc comments and
  `docs/hq/contracts.md` say so.
- **I6 fixed.** `assertHackathonMatches` moved from `authz.ts` to the
  already-pure `authz-sql.ts` and is re-exported, so the existing import path
  (used by `tests/hq/authz.test.ts`) keeps working; `lib/hq/actions/util.ts`
  now imports it from the leaf module directly. The graph from
  `lib/hq/actions/projects.ts` went from 29 modules to 17; `better-auth`,
  `@better-auth/core`, `resend` and `next/headers`'s auth-adjacent imports are
  gone from every operator action module's reachable set (`jose` remains,
  through the operator's own `session-token.ts`). New
  `tests/hq/operator-imports.test.ts` proves it by a static import walk — the
  mirror of `tests/hq/member-shell.test.ts`'s scan, but transitive rather than
  direct, since the coupling was three hops deep — and asserts the walk
  *does* reach `member-auth.ts` from the two member action modules, so the
  scan cannot pass by finding nothing. This is the test T4.2 and T4.3 had to
  design their own new action modules around (see their entries below).
- **M1, M2, M3 fixed.** `lib/hq/identity.ts` now re-exports
  `isPlaceholderEmail` (defined next to the function that mints the
  placeholder, in `lib/hq/telegram-provider.ts`, re-exported at the identity
  boundary), making the contracts claim true as written.
  `builder-store.ts#updateTeam`'s SQL predicate now requires
  `verification = 'verified'`, matching the decision. `toPublicPersonView`
  now drops capability labels unless the caller passes
  `{ includeCapabilities: true }`.
- **M6, M7 also fixed**, bundled in because they were cheap and touched the
  same admin area: `components/hq/builder-admin.tsx`'s account and project
  rows are now keyed by `account.id`/`project.id` alone (not also
  `account.captain`/`project.verification`), so a successful save no longer
  remounts the row and loses `ActionForm`'s own "Saved." confirmation or an
  open `<details>`; and a comment on `lib/hq/actions/capabilities.ts`
  explains why Captain grants are deliberately account-global rather than
  edition-scoped like the neighbouring `updateBuilderTier`.

Full findings, reasoning and the four implementer concerns judged sound are in
`.superpowers/sdd/2026-09-13-hq-captains-and-colosseum/task-REVFIX-report.md`.
Two concerns worth a later phase's attention, recorded rather than acted on:
`customSession`'s wider blast radius means phase 7's bot adapter (and
anything else reading a member session) must expect `email: null`, never a
placeholder, from every reader, not only the HTTP endpoint; and the
login-email-change notice to a previous address is, after I1, reachable only
by writing the confirmation intent directly, since no product flow can
trigger it any more — its test does exactly that, and is defending a feature
HQ does not currently offer.

**Blocked or deferred:** M4 and M5 (the People "Wrong match?" control) were
explicitly excluded from this fix wave as a phase 3 item, per the ledger; see
`docs/hq/contracts.md`'s "Handoff to phase 3" for the current state of that
control. The "agreed, can stay deferred" Minors from the review report are
unchanged. Three items created by this fix wave's own re-review, not
recorded anywhere else tracked (the workspace ledger they were only in is
deleted when the plan finishes):

- **`lib/hq/member-auth-client.ts` is built without `customSessionClient`**,
  so the inferred client session type still says `user.email: string` while
  the real type is `string | null`: `lib/hq/member-auth.ts`'s `customSession`
  transform returns `email: null` only for a Telegram-only account carrying
  the placeholder address, and the account's real address unchanged for a
  verified email account — not `null` for every reader. A client component
  cannot tell the two apart from the inferred type alone once one exists.
  Nothing calls `useSession()` today, so nothing is wrong yet — but this is
  exactly the future client component the transform was chosen over
  `disabledPaths` to protect (see "I2 fixed" above), and its type will lie
  to that first caller instead of warning it. **Phase 7 hand-off**: whoever
  writes the first client component that calls `useSession()` must add the
  `customSessionClient` plugin at that point, not assume the inferred type
  is already correct.
- **`customSession` swallows a `getSession()` failure into a sign-out.**
  Better Auth's own `custom-session` plugin (not `lib/hq/member-auth.ts`'s
  callback) wraps the core `getSession()` call in a `.catch` that resolves
  to `null` rather than rejecting — using the plugin adopts that behaviour,
  it is not written in this codebase — so an adapter or database failure
  during a member session read now presents to the member as an ordinary
  sign-out rather than an error. Fail-closed,
  which is the right default, but undocumented until now. **Phase 7
  hand-off**: the bot adapter and anything else built on top of a member
  session read should expect this and not treat "no session" as proof the
  member actually signed out.
- **`AuditActor` still permits `{ kind: "operator", id: null }`**, and
  nothing validates at runtime that `byOperatorId` (on `grantCapability`/
  `revokeCapability`) is an `hq_users` uuid — a member id passed there fails
  on the `::uuid` cast rather than being refused with a clear error. Noted
  during the fix wave's own review as "phase 4 is the natural place to
  narrow it"; phase 4 built two more callers of the same functions
  (`lib/hq/captains.ts`'s invitation redemption and assignment revocation
  cascade) without adding that validation. Not owned by a specific later
  phase — carried forward for whoever next changes `lib/hq/capabilities.ts`
  or adds another caller to reconsider, rather than left to be rediscovered
  as a confusing cast error.

**Changed interfaces:** `CapabilityChange = { actor: AuditActor;
byOperatorId: string | null; userId: string; capability: Capability; reason:
string }` in `lib/hq/capabilities.ts` (both `grantCapability` and
`revokeCapability`); `CaptainLeaderboardView` in `lib/hq/view-models.ts`;
`assertHackathonMatches` now defined in `lib/hq/authz-sql.ts`, re-exported
from `lib/hq/authz.ts` (no import-path change for existing callers);
`toPublicPersonView(person, { includeCapabilities? })` in
`lib/hq/view-models.ts`; `isPlaceholderEmail` re-exported from
`lib/hq/identity.ts`; `customSession` on the member Better Auth instance
(`lib/hq/member-auth.ts`), with `StoredAccount.email: string | null`.

**External configuration:** None added.

## Phase 4, Captain invitations, assignments and the Captain leaderboard

Tasks T4.1, T4.2, T4.3, T4.4 and T4.5, each independently reviewed with fix
rounds until clean. Branch `hq-captains-phases-0-2`, `9093467..e363fbe`.

### What changed, task T4.1

Schema only: `hq_captain_invitations`, `hq_captain_invitation_redemptions` and
`hq_captain_assignments` in `scripts/hq/builder-schema.sql`, the
`loadCurrentAssignment` loader swapped from an always-null stub to a real
read, and the reset classification for the three new tables. No service, no
route, no UI, per the standing "no stub source files" rule.

`hq_captain_invitations`: `id`, unique `token_hash`, `label`, `capability`
(`CHECK` restricted to `'captain'`, named
`hq_captain_invitations_capability_check`), `max_redemptions` (`CHECK > 0`,
named `hq_captain_invitations_max_redemptions_check`), `expires_at` (`NOT
NULL`), `created_by_user_id`/`revoked_by_user_id` (→ `hq_users(id)` `ON
DELETE SET NULL`), `created_at`, `revoked_at`.

`hq_captain_invitation_redemptions`: `id`, `invitation_id` (→
`hq_captain_invitations(id)` `ON DELETE CASCADE`), `user_id` (→
`hq_builder_profiles(id)` `ON DELETE SET NULL`, **nullable by design** — see
below), `redeemed_at`, `UNIQUE (invitation_id, user_id)`.

`hq_captain_assignments`: `id`, `project_id` (→ `hq_projects(id)` `ON DELETE
CASCADE`), `captain_user_id` (→ `hq_builder_profiles(id)` `ON DELETE SET
NULL`, nullable), `assigned_at`, `assigned_by_user_id`, `unassigned_at`,
`unassigned_by_user_id`, `reason`. Two partial indexes, after two fix rounds
(below): `hq_captain_assignments_one_current_idx` (**unique**, on
`(project_id)`) and `hq_captain_assignments_captain_current_idx` (on
`(captain_user_id)`), both `WHERE unassigned_at IS NULL AND captain_user_id IS
NOT NULL`.

**Redemption row on account deletion (decision).** `user_id` is nullable with
`ON DELETE SET NULL`, not `ON DELETE CASCADE`. The plan is explicit that
removing an account does not replenish an old invitation's usage allowance;
since capacity is counted by rows, the row must outlive the account it names.
This matches the codebase's existing convention for "who is this row about"
references into `hq_builder_profiles` from a history table
(`hq_people.builder_user_id`, `hq_project_members.builder_user_id`,
`hq_crm_persons.builder_user_id` are all nullable + `SET NULL`).

**CLEAR vs KEEP (decision).** `hq_captain_assignments` → **CLEAR**: it
answers "who is running this project", which only means something for a
project that still exists, and cascades from `hq_projects` (itself CLEAR)
regardless. `hq_captain_invitations` and `hq_captain_invitation_redemptions`
→ **KEEP**: both are account-level grant history in the same shape
`hq_account_capabilities` already is. Clearing the redemption rows while
`hq_builder_profiles` survives a reset (it is KEEP) would let the same
accounts redeem the same invitations again, silently replenishing every
invitation's capacity — the opposite of the plan's non-replenishment rule.

**Fix round 1 (commit `aebae7e`).** Review found one Important: the two
partial indexes' predicate (`unassigned_at IS NULL`) disagreed with
`loadCurrentAssignment`'s (`unassigned_at IS NULL AND captain_user_id IS NOT
NULL`). An account deletion leaves exactly that disagreement — `ON DELETE SET
NULL` clears `captain_user_id` but nothing touches `unassigned_at` — so
`loadCurrentAssignment` would report "no Captain" for a project whose unique
index still held that project's one slot, permanently refusing any new
assignment to it with a raw constraint violation. Fixed by narrowing both
index predicates to match the loader exactly, using `DROP INDEX IF EXISTS`
before each `CREATE ... IF NOT EXISTS` so a database that had already run the
first-round SQL would still pick up the corrected predicate.

**Fix round 2 (commit `d271f7e`).** The drop-then-create pair from round 1
reused the same index name on both sides, which means both statements would
run for real on **every** future `hq:migrate`, forever — not only the one
deploy that needed the correction — briefly dropping the "one current Captain
per project" invariant on every deploy and paying an index rebuild each time.
Fixed by retiring the round-1 names (`hq_captain_assignments_current_idx`,
`hq_captain_assignments_captain_idx`) with a bare `DROP INDEX IF EXISTS` that
is never recreated, and creating the corrected predicate under new,
permanent names (`hq_captain_assignments_one_current_idx`,
`hq_captain_assignments_captain_current_idx`). All four statements converge
to a no-op after one real run, matching the idiom of the rest of the file.
Taken while the branch was still unpushed and the table had never carried
live traffic, so the rename was free; it would not have been after T4.4
shipped.

### Checks passed, task T4.1

`tests/hq/migration-order.test.ts`'s `expectCaptainSchema` (tables, columns
via `information_schema.columns`, named `CHECK` constraints, FK
`confdeltype` per target table, index existence and exact `indexdef`,
retired-name absence), applied through the real splitter twice fresh and
three to four times over the populated pre-hackathon-scoping fixture, plus a
`describe("task T4.1: ...")` block of behaviour tests: "refuses a second
current assignment for the same project, and allows a historical row plus a
new current one"; "refuses a duplicate redemption of the same invitation by
the same account"; "refuses a non-positive max_redemptions"; "refuses a
capability other than 'captain'"; "keeps a redemption counting toward
capacity after the redeeming account is deleted"; "lets a project be
reassigned after its Captain's account is deleted (Important 1 regression)".
`tests/hq/authz.test.ts` "loadCurrentAssignment reads hq_captain_assignments:
no row, a current row, an ended row, and a malformed id without a query" (the
"without a query" case passes a throwing `BuilderQuery` stand-in, so a query
would fail the test rather than go unasserted). `tests/hq/reset.test.ts`:
`seedEverything()` now inserts one invitation, one redemption and one
assignment row, so the existing generic "has every hq_ table classified in
the reset manifest, and nothing classified that does not exist" and the
CLEAR/KEEP guard tests actually exercise the three new tables instead of
passing vacuously on zero rows (two of the generic assertions genuinely
failed before the seed rows were added — the implementer's own signal that
the classification tests are wired correctly).

Full suite at `d271f7e`: 788 tests in 35 files, `tsc` clean, lint unchanged
(0 errors, 18 pre-existing warnings).

### Blocked or deferred, task T4.1

None. The service, route and UI work is T4.2-T4.5's, by design.

### Changed interfaces, task T4.1

`loadCurrentAssignment(db, projectId): Promise<CurrentAssignment | null>` in
`lib/hq/authz-sql.ts` now reads real rows (`{ captainUserId }` or `null`)
instead of always returning `null`; its signature and result type are
unchanged from phase 1. `AUDIT_EVENT_KINDS` in `lib/hq/audit-sql.ts` gained
`captain.invitation_created`, `captain.invitation_revoked` and
`captain.invitation_redeemed`, alongside the phase-1-reserved
`captain.assigned`/`captain.unassigned` — none written yet at this commit.
New identifiers later tasks reference directly: the two named `CHECK`
constraints above; `hq_captain_assignments_one_current_idx` (the unique
index whose violation a service must catch and turn into a typed outcome
rather than surface as a raw Postgres error); the redemption table's
Postgres-generated unique-violation name,
`hq_captain_invitation_redemptions_invitation_id_user_id_key`.

### External configuration still required, task T4.1

None added.

### What changed, task T4.2

The invitation half of the Captain service. New `lib/hq/captains.ts`
(server-only): `createCaptainInvitation`, `readCaptainInvitationByToken`,
`acceptCaptainInvitation`, `revokeCaptainInvitation`,
`listCaptainInvitations`. New `lib/hq/actions/captains.ts` (`"use server"`,
operator-gated, added to `tests/hq/auth-boundary.test.ts`'s `ACTION_GATES` as
`"operator"`): `createCaptainInvitation`, `revokeCaptainInvitation`. New
Admin section in `components/hq/builder-admin.tsx` (`CaptainInvitations`): a
create form (default 1 account, 7 days), a live expiry preview in the
edition's timezone, a one-time link panel, and a list of invitations with
state, capacity, creator, redeemers and a revoke control.
`lib/hq/format.ts` gained `fmtWithZone(iso, tz)` (an absolute moment with the
IANA zone name spelled out, not a locale abbreviation).

**`ActionForm` gained a `resetOnSuccess` prop (default `false`).** This is
the fix for the REVFIX-adjacent hazard the whole-branch review's fix wave
flagged but did not itself fix (its own "row remount" fix, M6, was a
different defect in the same component): without a reset, a successful
Grant/Revoke Captain save left the confirmation checkbox and reason text
filled in while the control flipped to its opposite label, one click away
from an accidental reversal. Scoped to only the two controls whose summary
and button both flip label after a save (Grant/Revoke Captain, Review/Change
team verification); every other form on the page takes server `defaultValue`
props and would otherwise flash the pre-save value next to "Saved." until
revalidation.

**Decision — where the verified-account check sits.** Inside
`acceptCaptainInvitation` itself, not the caller, so it cannot be bypassed
regardless of who calls the service and so it is testable as a service-level
guarantee. The original submission used a **dynamic** `await
import("./identity")`, scoped inside the one function that needs it, to keep
the check out of `lib/hq/actions/captains.ts`'s statically-scanned import
graph (`tests/hq/operator-imports.test.ts`). Review judged this a **false
fix**: a dynamic `import()` is still a real graph edge for the production
bundler, so `identity.ts → telegram-provider.ts → @better-auth/core + jose`
remained in the operator bundle; the dynamic form only evaded the test's
regex, which cannot see `await import(...)`. Fixed in round 1 the way REVFIX
fixed I6: `isPlaceholderEmail` extracted to a new leaf module
`lib/hq/placeholder-email.ts` (re-exported from `telegram-provider.ts` for
existing callers), with `identity.ts` and `builder-store.ts` both re-pointed
to import it from the leaf directly rather than through
`telegram-provider.ts` — either one still pointing at the provider module
would have kept the forbidden edge alive, since `identity.ts` is itself
imported by `builder-store.ts`. `lib/hq/captains.ts` now imports
`isVerifiedAccount` from `./identity` **statically**. Verified with the real
scan, not just reasoning: `operator-imports.test.ts` passes with the static
import in place.

**Decision — an account that already holds `captain` consumes no slot on
first redemption.** `{ outcome: "already-captain" }`, no redemption row, no
new call to `grantCapability`. Reasoning: "an already authorized Captain
does not consume a new slot" plus "a use means one account newly *receiving*
access" — an account that already has the capability receives nothing new
from this link. This check runs before the revoked/expired/full checks,
since it applies regardless of the link's own state.

**Decision — `maxRedemptions` capped at 500** (`lib/hq/captains.ts`'s
`MAX_REDEMPTIONS`). Far beyond any realistic Captain cohort for one edition;
finite so a typo (an extra zero) fails loudly rather than becoming
unlimited. A matching `MAX_VALIDITY_DAYS = 365` was added in fix round 1 for
the same reason applied to a link's lifetime, with a matching `max={365}` on
the Admin form's "Valid for (days)" input.

**Check order inside `acceptCaptainInvitation`,** after locking the
invitation row: (1) an existing redemption row for this
`(invitationId, userId)` wins over everything — including a since-revoked
invitation or a since-revoked grant, which is what makes a revoked grant
impossible to resurrect by replaying an already-consumed redemption; (2)
already-active-captain, as above; (3) only then revoked/expired/full gate a
genuinely new grant.

### Checks passed, task T4.2

`tests/hq/captains.test.ts` (new): "stores only the hash: no column of any
table holds the plaintext token"; "defaults capability to captain and
validates maxRedemptions and expiry"; "returns redeemability only — never
the token, the creator, or a redeemer list"; "returns null for an unknown
token, and consumes nothing"; "refuses an unverified account without
touching anything"; "accepts a Telegram-verified account exactly like an
email-verified one"; "returns not-found for an unknown invitation id";
"returns a typed outcome for a verified account whose builder profile has
not synced yet, instead of an unhandled foreign-key error" (the `no-profile`
outcome added in fix round 1); "a one-use link: the first acceptance grants,
a second distinct account is refused as full"; "a multi-use link honours its
exact capacity"; "overlapping acceptance calls never exceed capacity,
however many arrive at once" (renamed in fix round 1 from a name that
overclaimed — see the phase 4 acceptance checklist below for exactly what
this does and does not prove); "locks the invitation row for the whole
decision — a regression guard, since PGlite's serialized test pool cannot
itself prove concurrency safety" (a new source-level test added in fix round
1, asserting the exact `FOR UPDATE` SQL text is present); "repeat acceptance
by the same account is idempotent and consumes no second slot"; "a replay
after an admin revoked that account's grant does not re-grant it"; "an
account that already holds Captain from elsewhere does not consume a slot";
"revoked and expired links refuse redemption without touching an existing
grant"; "commits the redemption row, the grant and the audit event together,
or none of them" (constraint-kill mid-transaction); "stops future
redemption, keeps existing grants, and is idempotent" (revoke); "returns
null for an unknown invitation"; "lists label, capacity, used count, expiry,
revocation state, creator and redeemers, newest first"; "shows an expired
invitation as expired, not full or active"; "still counts a redemption
toward usedCount after its account is deleted, and shows it as deleted".

`tests/hq/builders-admin.test.ts`, `describe("Captain invitations in
Admin")`: "creates an invitation through the operator action, returning its
token once and refreshing HQ"; "refuses a bad shape at the zod boundary and
an unreasonable account limit with the service's own message"; "revokes an
invitation, stays idempotent on a second call, and reports an unknown id the
same way"; "renders the invitations section with its one-use default copy,
an active invitation and its redeemer" (a `renderToStaticMarkup` test
confirming the token never appears in markup). `tests/hq/auth-boundary.test.ts`:
`captains.ts` added to `ACTION_GATES`. `tests/hq/operator-imports.test.ts`:
re-run explicitly to confirm the fix-round static import actually satisfies
the scan, not merely the reasoning behind it. `tests/hq/format-ago.test.ts`
extended with `fmtWithZone` cases (fixed instant, two zones with different
UTC offsets and DST states, empty-string and unparseable-date branches).

Full suite at `8dca3c4` (fix round 1 complete): 821 tests in 36 files, `tsc`
clean, lint unchanged (0 errors, 18 pre-existing warnings), `npm run build`
passing.

### Blocked or deferred, task T4.2

Two minors deferred by the coordinator during fix round 1, out of scope: the
inline `style={{}}` on the Admin link panel; `hasTelegramIdentity` reading
the global pool rather than the query handle it is passed. Neither affects
correctness. Two further minors surfaced only by the fix-round re-review,
not overlapping the pair above: no automated test exercises the create
form's `try/catch` added for Important 2 (component tests in this codebase
use `renderToStaticMarkup`, which never drives `onSubmit`, so a regression
here would currently pass unnoticed); and no test pins `MAX_VALIDITY_DAYS`'s
365/366-day boundary, though the sibling `maxRedemptions` bound is tested at
both edges. Both correct by inspection at this commit; neither is owned by
a later phase specifically — either is a small addition whenever
`lib/hq/actions/captains.ts` or `lib/hq/captains.ts` is next touched.

### Changed interfaces, task T4.2

`lib/hq/captains.ts`: `createCaptainInvitation(db, { actorOperatorId, label?,
maxRedemptions, expiresInDays? | expiresAt? }): Promise<CaptainInvitationCreation>`
(`{ token, invitation }` — `token` is the one-time plaintext bearer value);
`readCaptainInvitationByToken(db, token): Promise<CaptainInvitationRedeemability
| null>` (`{ id, capability, label, expiresAt, expired, revoked, full }` —
never identity); `acceptCaptainInvitation(db, { invitationId, userId }):
Promise<AcceptCaptainInvitationResult>`, a nine-member discriminated union on
`outcome` (`granted`, `already-redeemed`, `already-captain`, `revoked`,
`expired`, `full`, `unverified`, `not-found`, `no-profile`);
`revokeCaptainInvitation(db, { actorOperatorId, invitationId, reason? }):
Promise<CaptainInvitationListing | null>` (idempotent); `listCaptainInvitations(db):
Promise<CaptainInvitationListing[]>`. `lib/hq/placeholder-email.ts` (new leaf
module): `PLACEHOLDER_DOMAIN`, `isPlaceholderEmail` (re-exported from
`lib/hq/telegram-provider.ts` and `lib/hq/identity.ts` for existing callers).
`lib/hq/member-routes.ts`: `inviteLink(token): string`. `lib/hq/format.ts`:
`fmtWithZone(iso, tz): string`. `components/hq/builder-admin.tsx`'s
`ActionForm` gained `resetOnSuccess?: boolean` (default `false`).

### External configuration still required, task T4.2

None added.

### What changed, task T4.3

The `/hq/invite/<token>` flow. `app/hq/(member)/invite/[token]/route.ts`
(Route Handler, not a page — `cookies().set()` is only legal in a Server
Function or Route Handler): checks the session without ever gating on it,
calls `exchangeCaptainInvitationToken` (new `lib/hq/invite-exchange.ts`),
sets or clears the continuation cookie, and redirects to
`INVITE_CONTINUE_PATH` — with no token anywhere in the redirect target. New
`lib/hq/invite-continuation.ts` is the continuation store: writes and reads
Better Auth's own `hq_auth_verification` table directly (the same table
`recordTelegramIntent` uses, under a different identifier prefix,
`hq-invite-continuation:<id>`), keyed by a fresh random 24-byte id rather
than a user id, 30-minute TTL, holding `{ invitationId, expired, revoked,
full }` and nothing else. New `app/hq/(member)/invite/continue/page.tsx`:
no continuation → a generic invalid-link message; a continuation whose
exchange-time snapshot says revoked/expired/full → that specific dead-end
message, for anyone; otherwise the explanation plus, for a signed-in
visitor, the accept control (`accept-form.tsx`, `useActionState` over the
new action), or for a signed-out visitor a sign-in link back to the same
page. New `lib/hq/actions/invite.ts` (`"use server"`, **member**-gated, its
own file — `lib/hq/actions/captains.ts` is scanned as an operator module and
`requireMemberActor()` would break that scan):
`acceptCaptainInvitationFromContinuation()`. New
`app/hq/(member)/invite/copy.ts`: an exhaustive `Record` over every outcome
value (TypeScript's exhaustiveness check means an outcome added to the
service without matching copy here fails to build).

**Decision — the continuation's home and lifetime.** An httpOnly cookie
(`hq_invite_continuation`, `path=/hq/invite`, `sameSite=lax`, secure exactly
when the member session's own cookies are) holding a random 24-byte id; the
server-side row lives in `hq_auth_verification`; both expire 30 minutes
after the exchange. Chosen over a continuation id in the URL because it
keeps the address free of any bearer value at all (not the token, not the
continuation id), including through a sign-in round trip to
`/hq/signin?next=/hq/invite/continue`. 30 minutes rather than the Telegram
intent's 10, because a first-time invitee taking the email-OTP **sign-up**
path needs time to read mail and possibly resend a code.

**Decision — a purpose-built store, not a reuse of `recordTelegramIntent`.**
`recordTelegramIntent` is keyed by user id and consumed by Better Auth's own
endpoint hooks; the invitation continuation names no user (a visitor may
have no account yet) and no Better Auth endpoint ever reads it, so writing
straight through the shared `builderDatabase()` pool under a different
identifier prefix in the same table is simpler and testable against PGlite
with no live Better Auth instance.

**Decision — the exchange's rate limit.** 30 requests per 15 minutes, keyed
on the requesting IP (`x-real-ip` then the first `x-forwarded-for` entry,
matching `lib/hq/actions/auth.ts`'s own extraction), reusing `hq_login_limits`.
Explicitly defence in depth, not the primary control: a 32-byte random token
is not brute-forceable in any plausible window, so the limit exists to blunt
a naive scan or a broken retry loop, loose enough that a shared office
address or a repeatedly-refetching preview bot never trips it.

**Decision — a member never sees an invitation's internal label, creator,
capacity or usage.** The continuation carries only the three redeemability
flags; nothing in the flow reads or forwards `label`, so there is no code
path that could render it.

**Fix round 1 (commit `8cbdddb`).** Important: the route only ever called
`response.cookies.set(...)` on a **successful** exchange; the failure branch
(unknown token, or rate-limited) left the cookie jar untouched. A visitor who
had already exchanged invitation A, then followed a different dead link (a
typo, a revoked link, enough retries to trip the rate limit), kept the stale
A continuation and was redirected onto its live Accept control — one click
from a redemption against an invitation they never followed. Fixed by
clearing the cookie on every non-success branch, not only setting it on
success; proved by reverting the fix and watching the new assertions fail
before restoring it. Six bundled minors: an `eslint.config.mjs` rule
override (`argsIgnorePattern: "^_"`) removing two avoidable
`no-unused-vars` warnings `useActionState`'s signature forces;
`INVITE_CONTINUE_PATH` replacing three literal-path repetitions;
`X-Robots-Tag: noindex, noarchive` added beside `Referrer-Policy` on the
`/hq/invite/:path*` `next.config.ts` entry; `safeMemberNext` explicitly
asserted over `/hq/invite/continue`; the redirect built from
`new URL(INVITE_CONTINUE_PATH, request.nextUrl)` rather than `request.url`;
a config-level test for the `headers()` entry itself (see the open manual
item below — this test proves the config, not the served response).

**Ruling recorded, not a defect:** "already accepted by this account" is
shown only after the Accept submit, never as a pre-click state, because
showing it beforehand would need a redeemability pre-check the invitation
design forbids (a read-then-write race and a second copy of the rule
`acceptCaptainInvitation` already owns).

### Checks passed, task T4.3

`tests/hq/invite-continuation.test.ts`: "is a random, URL-safe id unrelated
to any invitation id"; "round-trips exactly what was stored"; "is null for
an id that was never recorded — a forged or guessed cookie value"; "is null
once the row has expired, and stays null on every later read"; "is read
repeatedly without being consumed — unlike recordTelegramIntent, a page load
or a retried accept must not burn it"; "stores the invitation's exchange-time
flags, not just its id"; "carries no other invitation field: only
invitationId and the three flags reach the row"; "opportunistically clears
its own expired rows on the next write, without touching an unrelated
verification row"; "is httpOnly, scoped to /hq/invite, and expires with the
continuation's own TTL"; "follows the member session's own secure-cookie
policy: secure over a configured https origin, not over an unconfigured
one". `tests/hq/invite-exchange.test.ts`: "consumes nothing for a valid
token, called twice — a link preview, then a real visit"; "never puts the
token into the continuation id"; "creates no continuation for an unknown
token, and writes nothing"; "still records a continuation for a revoked
token, carrying the revoked flag" (and the equivalent for expired and full);
"rate-limits an address after repeated exchanges, and a limited request
creates no continuation either". `tests/hq/invite-route.test.ts`: "checks
the session (every /hq surface does, tests/hq/auth-boundary.test.ts) without
ever gating on it"; "redirects
to the tokenless continuation page, with no token anywhere in the target";
"sets an httpOnly continuation cookie scoped to /hq/invite, and the stored
continuation names the right invitation"; "consumes nothing, exchanged twice
for the same token — a link preview, then a real visit"; "redirects an
unknown token the same way, and clears (rather than merely omits) the
continuation cookie"; `describe("a failed exchange clears a previously-set
continuation cookie")` → "for an unknown token" and "for a rate-limited
address" (the Important-1 regression, sending a stale cookie the way a real
browser would and asserting the response clears it, plus that the original,
unrelated continuation is untouched server-side); "still redirects to the
continuation page for a revoked token, with a continuation that says so".
`tests/hq/invite-accept-action.test.ts`: "refuses a signed-out visitor:
requireMemberActor's own gate, before any continuation is even read"; "a
failed sign-up followed by a successful one consumes exactly one slot — the
acceptance check the plan names directly"; "refuses an unverified account,
without touching the database"; "grants Captain to a verified, signed-in
account, then leaves a second acceptance a no-op that consumes no slot";
"passes every outcome acceptCaptainInvitation can return straight through,
unmodified"; "is refused for a missing, forged or expired continuation —
identically, without reaching acceptCaptainInvitation at all"; "still checks
the account's own verification and profile even when the continuation names
a real, open invitation". `tests/hq/invite-page.test.ts`: "shows a generic
invalid-link message when there is no continuation cookie at all, and
mentions no invitation"; "shows the same invalid-link message for a cookie
that resolves to nothing — forged, unknown or expired, indistinguishably";
"shows a signed-out visitor the explanation and a sign-in link that returns
here, never the accept control"; "shows a signed-in, verified visitor the
accept control for an open invitation"; an `it.each` over revoked/expired/full
showing the matching message and no accept control for either session state;
"never renders the invitation id, a continuation id or anything that looks
like a bearer token". `tests/hq/invite-accept-form.test.ts`: the initial
button, the pending/disabled state, "renders the granted outcome with a
status role, success copy and a link to the Captain page", `it.each` over
`already-redeemed`/`already-captain` (status role, no link) and over the
remaining seven outcomes (alert role, no link). `tests/hq/captains.test.ts`
extended: "changes nothing when read twice in a row — modelling a link
preview immediately followed by a real visit" (this is the preview/no-slot
acceptance proof — see the phase 4 checklist below). `tests/hq/invite-config-headers.test.ts`:
"has exactly one entry, matching both the token exchange route and the
continuation page"; "sets Referrer-Policy: no-referrer and X-Robots-Tag:
noindex, noarchive" — this test proves the `next.config.ts` entry itself,
**not** that the header lands on the served response; see "Blocked or
deferred" below.

Full suite at `8cbdddb` (fix round 1 complete): 880 tests in 43 files, `tsc`
clean, lint back to the baseline (0 errors, 18 pre-existing warnings — the
two `lib/hq/actions/invite.ts` warnings from the original submission are
gone), `npm run build` passing (`/hq/invite/[token]` and `/hq/invite/continue`
listed as distinct routes).

### Blocked or deferred, task T4.3

**Open manual item, not run this session.** The `Referrer-Policy:
no-referrer` and `X-Robots-Tag: noindex, noarchive` headers for
`/hq/invite/:path*` are asserted at config level only
(`tests/hq/invite-config-headers.test.ts`). The route tests drive the
exported `GET`/page functions directly, below the layer that applies
`next.config.ts`'s `headers()`, so confirming the headers actually land on
the **redirect** response (and on the continuation page's response) needs a
manual `curl -I` against a running `next dev` or `next start`. Not run.
Carried into `docs/hq/manual-setup.md`.

The `identifier LIKE 'hq-invite-continuation:%'` lookup in
`lib/hq/invite-continuation.ts` is not index-assisted under a non-C
collation — deferred as harmless at this table's size.

### Changed interfaces, task T4.3

`lib/hq/invite-exchange.ts`: `InviteExchangeResult = { continuationId: string
| null }`, `exchangeCaptainInvitationToken(db, { token, ip }):
Promise<InviteExchangeResult>`. `lib/hq/invite-continuation.ts`:
`INVITE_CONTINUATION_TTL_MS`, `INVITE_CONTINUATION_COOKIE`,
`InviteContinuation`, `InviteContinuationCookieOptions`,
`inviteContinuationCookieOptions()`, `newInviteContinuationId()`,
`recordInviteContinuation(db, id, continuation)`,
`readInviteContinuation(db, id)`. `lib/hq/actions/invite.ts`:
`AcceptCaptainInvitationOutcome` (the service's nine outcomes plus
`"invalid-continuation"`), `AcceptCaptainInvitationActionResult`,
`acceptCaptainInvitationFromContinuation()`. `lib/hq/member-routes.ts`:
`INVITE_CONTINUE_PATH` (exported constant; `INVITE_PATH_PREFIX` stays
module-private, used only by `inviteLink()` and the route list).
`next.config.ts`: one `headers()` entry for `/hq/invite/:path*`.

### External configuration still required, task T4.3

None added.

### What changed, task T4.4

The assignment half of the Captain service, extending `lib/hq/captains.ts`:
`assignCaptain`, `unassignCaptain`, `clearCaptainAssignments`,
`countAssignmentsForCaptain`, `countAssignmentsForUsers`, `listAssignments`.
The membership-acceptance guard: `redeemInvite` and `importTeam`
(`lib/hq/builder-store.ts`) each gained a check, right after their existing
lock on `hq_project_onboarding`, refusing when the joining or claiming
account is currently the project's Captain. The revocation cascade:
`lib/hq/actions/capabilities.ts#revokeCaptainCapability` now opens one
`builderDatabase().transaction(...)`, calls `revokeCapability(tx, ...)` then,
only if a grant was actually revoked, `clearCaptainAssignments(tx, ...)` —
`ActionResult` stays the return type; the admin-facing count is a separate
pre-flight read shown **before** the confirmation, not a post-action return
value. Admin count-before-confirm: `BuilderAccount.captainAssignmentCount`
(one batched `countAssignmentsForUsers` call in `getBuilderAdminData`), used
in the revoke confirmation copy. New operator actions in
`lib/hq/actions/captains.ts`: `assignProjectCaptain`, `unassignProjectCaptain`,
`bulkAssignProjectCaptain` — each resolves the edition through
`requireHackathon()`, never a client-supplied id. New Admin controls in
`components/hq/projects.tsx`: a Captain field and picker on the project
detail panel (limited to accounts with an active Captain grant, resolved
server-side, never every account shipped to the client), an inline
confirmation banner for `needs_review`, and an "Assign Captains" bulk mode
(toggle, picker, filter-scoped checkbox list, per-project results).
`Project` gained `captainUserId`/`captainName` (mirroring `partnerId`/
`partnerName`); `ProjectPatch` gained a `"captain"` kind.

**Decision — unresolved roster identity blocks by default, proceeds only on
an explicit second call.** `assignCaptain` returns `needs_review` (writing
nothing) unless the caller passes an id list naming exactly the unresolved
rows shown. Rejected a hard, un-overridable block: with phase 3 not run,
almost every imported roster has at least one unclaimed member with no
`person_id`, so a hard block would make Captain assignment practically
unusable rather than merely cautious.

**Decision — the capability check inside `assignCaptain` is a locking `SELECT
... FOR UPDATE`, not `listActiveCapabilities`.** This is what fully
serializes a concurrent `assignCaptain` against a concurrent
`revokeCaptainCapability` for the same account: whichever transaction
reaches the row first runs to completion before the other proceeds, so the
loser always sees the real, already-committed outcome.
`listActiveCapabilities` takes no lock and would leave a window where a
just-revoked grant could still read as active.

**Decision — the lock order,** documented in `lib/hq/captains.ts`: (1)
`hq_account_capabilities` (candidate's active grant) — locking read; (2)
`hq_projects` — plain read (nothing concurrent mutates `hackathon_id`); (3)
`hq_project_onboarding`, locked **if present** (Postgres refuses `FOR
UPDATE` on the nullable side of an outer join, discovered when the
implementer's first draft tried to lock both tables in one statement — the
same row `redeemInvite`/`importTeam` also lock); (4) `hq_captain_assignments`
— the project's current-assignment row. `unassignCaptain`/
`clearCaptainAssignments` only ever need step 4. The one case this order
does not itself serialize — two concurrent `assignCaptain` calls on a
never-before-assigned project, where step 4 has no row yet to lock against —
is closed by the database instead: the insert is `ON CONFLICT (project_id)
WHERE unassigned_at IS NULL AND captain_user_id IS NOT NULL DO NOTHING`, and
the loser gets a typed `{ outcome: "conflict", conflict: { kind:
"already_assigned" } }` rather than an unhandled constraint violation.

**Fix round 1 (commits `b1c808c`, `7af462f`), three Important findings.**

- **Important 1.** A project's own claimant, absent from or case-mismatched
  against the imported roster, could be made Captain of their own team.
  `importTeam` links a roster row to the claimant only on an exact
  `member.username === owner.username` match; a claimant who fails that
  match gets `owner_user_id` set on `hq_project_onboarding` but no linked
  `hq_project_members` row. On a pending claim, `loadTeamMembership` sees
  nothing (it requires `verification = 'verified'`), and the old
  roster-scan-only conflict check saw nothing tying the claimant to the
  project either — so the assignment surfaced as `needs_review`, and one
  acknowledged "Assign anyway" made the project's own claimant its Captain.
  Fixed with a new, earlier-running `CaptainConflictReason` kind,
  `"claimant"`: `checkCaptainConflict` now compares the onboarding row's own
  `owner_user_id` against the candidate directly, independent of
  verification state and independent of any roster link, closing the window
  `loadTeamMembership` alone cannot see. `unassignProjectCaptain` and
  `reviewBuilderProject` needed no change — the fix is in the shared
  conflict machinery, and `assignCaptain` now refuses to create the forbidden
  state regardless of when verification happens.
- **Important 2.** A code comment claimed the (deliberately unlocked) step-2
  `hq_projects` read serializes two concurrent first-ever assignments; it
  does not. Rewritten to say plainly that the partial unique index plus
  `ON CONFLICT DO NOTHING` is what actually guarantees that case, load-bearing
  rather than defensive, with an explicit "do not remove this clause" note.
- **Important 3.** The acknowledged-override audit trail recorded only a
  count (`unresolvedRosterAcknowledged: number`), re-deriving the unresolved
  set in the second transaction — so the event could attest to acknowledging
  rows the operator never actually saw. Fixed with the stronger option:
  `acknowledgeUnresolved?: boolean` became `acknowledgedUnresolvedIds?:
  string[]`, checked against the transaction's own freshly re-derived
  unresolved set (`acknowledgesExactly`, order-independent, set-size checked
  so a duplicate id cannot substitute for a distinct one); a mismatch is
  treated as no acknowledgement and returns `needs_review` again with the
  current set. The audit event's metadata now carries
  `acknowledgedUnresolvedMemberIds: string[]`, the actual ids.

Seven bundled minors, all fixed: the concurrent-`assignCaptain` test's name
renamed to state only what it proves (sequential safety under PGlite's
serialized queue, not true interleaving), with a new database-level test of
the exact `ON CONFLICT DO NOTHING` insert proving the guard directly; the
Admin bulk picker's selection intersected with the current filter at submit
time, and the displayed count corrected to match; `bulkAssignProjectCaptain`
returning a typed `{ outcomes, error }` instead of a bare `[]` on a
whole-batch schema failure; `unassignCaptain`'s "commits a write while
reporting not_assigned" behaviour documented rather than changed, and
`assignCaptain`'s step 4 fixed to end every live row it locks (no `LIMIT`)
rather than only `current[0]`; a new indexed aggregate,
`countAssignmentsByCaptain`, added for T4.5's leaderboard rather than a
client-side grouping of `listAssignments`; stale `captainReview` UI state now
cleared on collapse, row switch, removal and deletion, and the ~60-line
inline Captain control extracted to `CaptainField`; a new pinned test
proving the Captain-role refusal wins over `importTeam`'s pre-existing
"already verified" message for an already-verified team too.

**Deferred, confirmed correctly out of scope.** The CRM-person-link race:
`correctPersonMatch` (an operator action) and `assignCaptain`'s conflict
check (source 2, the roster scan) share no lock, but pre-phase-3 every
roster row's `person_id` is universally `NULL`, so there is nothing for
either side to race over yet. Recorded explicitly as a phase 3 hand-off:
once phase 3 wires `ensurePersonForRosterMember` into the import path and
roster rows carry real `person_id` values, an admin correcting a person
match at the same moment another admin assigns a Captain to a project that
match's roster row belongs to could, in principle, land the state this task
closed for the other two races (membership acceptance, and the claimant's
own username). Whoever picks this up should decide whether the pair needs a
shared lock or is rare and operator-triggered enough on both sides to leave
as is.

### Checks passed, task T4.4

`tests/hq/captains.test.ts`: "refuses an account without an active captain
grant, writing nothing"; "treats a project from another edition exactly like
a missing one" (both `assignCaptain` and `unassignCaptain`); "assigns a
first Captain, recorded in the same transaction as its audit event";
"reassignment ends the old assignment, starts the new one, and leaves
exactly one current row plus history"; "a verified team member cannot be
assigned to their own team — the owner case" and "— the joined-member case";
"a roster identity linked to the candidate's account blocks assignment even
without a verified HQ membership"; "a project's own owner is a conflict even
before verification — the window loadTeamMembership alone misses"; "a
claimant absent from the imported roster (or case-mismatched against it) is
still a conflict, never needs_review" (the Important-1 regression); "an
unresolved roster identity produces the needs-review outcome rather than a
silent pass, and only proceeds once explicitly acknowledged"; "refuses a
stale acknowledgement: an id list that no longer matches the current
unresolved set is treated as no acknowledgement at all"; "refuses a
duplicate-id substitution: the same real id sent twice never counts as
acknowledging two distinct rows"; "never compares display names: an
unclaimed roster row whose name matches the candidate is still only 'needs
review', never a silent conflict or a silent pass"; "a project with no
imported roster (created directly in Admin) has nothing for source 2 to
check, and a bare project assigns cleanly"; "two Promise.all-issued
assignCaptain calls for the same never-before-assigned project settle to one
current row — proves sequential safety only, the same thing the reassignment
test already proves"; "the ON CONFLICT DO NOTHING guard itself: a second
current-row insert for the same project is silently refused at the database
level, never a raised constraint violation"; "locks the candidate's active
grant, the project's onboarding row (if any) and the current assignment row
for update — a regression guard, since PGlite's serialized test pool cannot
itself prove concurrency safety"; `describe("the membership-acceptance lock
order (lib/hq/builder-store.ts)")` → "redeemInvite and importTeam lock the
same hq_project_onboarding row assignCaptain locks, and check
hq_captain_assignments before admitting a member or a verified owner — a
regression guard for the shared lock order"; "ends the current assignment,
is idempotent, and audits the removal"; "a project with no assignment at all
is not_assigned, not an error"; "clears every current assignment across
every edition, auditing each individually, and counting the same set
beforehand"; "counts current assignments for many accounts in one indexed
query, 0 for none"; "revoking a grant and clearing its assignments are one
transaction: forcing the clear's own audit write to fail leaves the grant
active and the assignment live"; "rolls the clear back if its own
transaction fails, leaving the assignment live"; "lists every project's
current Captain in one edition, and narrows to one Captain's own projects
there"; "never shows an orphaned row (a deleted account's former seat) as a
current assignment"; "has separate, non-overlapping effects from Captain
revocation: stops future redemption only, touches neither an existing grant
nor an existing assignment" and "the reverse: Captain revocation (and its
cascade) clears the assignment and touches no invitation" (both in the
`revokeCaptainInvitation` describe block).

`tests/hq/builder-onboarding.test.ts`, `describe("Captain assignment races
with membership acceptance")`: "ordering 1 (assignment first): a Captain
already assigned to a project cannot then join it through a team invite";
"ordering 2 (membership first): a team member who already joined a project
cannot then be assigned as its Captain"; "the 'claim' path: a Captain
already assigned to a pending project cannot then claim it as its verified
owner"; "pins that the Captain-role refusal now wins over the pre-existing
'already verified' message, for an already-verified team too".

`tests/hq/builders-admin.test.ts`, `describe("Captain assignment in Admin
(task T4.4)")`: "assigns and unassigns a Captain on a project created
directly in Admin, refreshing HQ"; "refuses an account without an active
Captain grant, with an operator-facing message, writing nothing"; "surfaces
a conflict as a named, operator-facing error rather than assigning";
"returns needs_review for an unresolved roster identity and only assigns
once explicitly acknowledged by the exact rows shown"; "treats a project
from another edition exactly like a missing one"; "reports per-project
outcomes in bulk — a conflicted or needs-review project is named, not
silently skipped, and does not stop the rest"; "reports a whole-batch error,
rather than a silently empty result, when the request itself is invalid";
"shows the affected project count before a revocation and clears the
assignment in the same action"; "renders the real assignment count in the
revoke confirmation copy, and the grant-side copy when there is none to
lose".

`tests/hq/authz.test.ts`, `describe("assignCaptain feeding real rows into
authorizeProjectAction (task T4.4)")`: "after assignment the Captain gets
CAPTAIN_ACTIONS but not membership.change; after unassignment the next call
denies everything" — one integration test proving `loadCurrentAssignment`
correctly reads what `assignCaptain`/`unassignCaptain` actually write,
separate from the phase-1 fixture tests, which stay unchanged and continue
to inject their own loader.

Full suite at `7af462f` (fix round 1 complete): 930 tests in 43 files, `tsc`
clean, lint unchanged (0 errors, 18 pre-existing warnings), `npm run build`
passing.

### Blocked or deferred, task T4.4

The CRM-person-link race (above) — phase 3 hand-off. A project deleted
concurrently with an assignment to it surfaces a raw foreign-key violation
rather than a typed outcome (a pre-existing class of gap across the other
operator project actions too, not newly introduced or closed here). The
`already_assigned` branch of the `ON CONFLICT DO NOTHING` guard is provably
unreachable inside the PGlite test harness by construction (step 4's lock
predicate is a strict superset of the partial index's own predicate, so
within one transaction step 4 always already sees and ends any row the
following insert could conflict with) — proven instead by a direct
raw-SQL test of the exact insert statement.

### Changed interfaces, task T4.4

`lib/hq/captains.ts`: `UnresolvedRosterMember = { memberId, name, username }`;
`CaptainConflictReason` (a discriminated union: `verified_member`,
`roster_member`, `claimant`, `already_assigned`); `AssignCaptainResult`
(`assigned` with `{ assignmentId, replacedCaptainUserId }`, `not_found`,
`no_grant`, `conflict` with the reason above, `needs_review` with
`unresolved: UnresolvedRosterMember[]`); `assignCaptain(db, {
actorOperatorId, projectId, hackathonId, captainUserId, reason?,
acknowledgedUnresolvedIds? }): Promise<AssignCaptainResult>`;
`UnassignCaptainResult` (`unassigned` with `{ assignmentId, captainUserId }`,
`not_assigned`, `not_found`); `unassignCaptain(db, { actorOperatorId,
projectId, hackathonId, reason? }): Promise<UnassignCaptainResult>`;
`ClearedCaptainAssignment = { assignmentId, projectId, projectName,
hackathonId }`; `clearCaptainAssignments(db, { actor, byOperatorId,
captainUserId, reason? }): Promise<ClearedCaptainAssignment[]>`;
`CaptainAssignmentSummary = { projectId, projectName, hackathonId }`;
`countAssignmentsForCaptain(db, userId): Promise<CaptainAssignmentSummary[]>`
(global across editions); `countAssignmentsForUsers(db, userIds):
Promise<Map<string, number>>` (batched); `CurrentCaptainAssignment = {
projectId, projectName, hackathonId, captainUserId, captainName, assignedAt }`;
`listAssignments(db, { hackathonId, captainUserId? }):
Promise<CurrentCaptainAssignment[]>` (edition-scoped; `captainUserId` is a
query filter, not an authorization boundary — every call site must gate
itself before choosing what to pass); `CaptainAssignmentCount = {
captainUserId, captainName, assignedCount }`; `countAssignmentsByCaptain(db,
hackathonId): Promise<CaptainAssignmentCount[]>` (one indexed `GROUP BY`
query, edition-scoped, ordered by count then name).

`lib/hq/actions/captains.ts`: `AssignCaptainActionResult` (a narrower,
3-outcome client-facing type: `assigned | needs_review | error`);
`assignProjectCaptain(input)`, `unassignProjectCaptain(projectId)`,
`BulkAssignCaptainOutcome`, `BulkAssignCaptainResult = { outcomes, error:
string | null }`, `bulkAssignProjectCaptain(input)`. `Project` gained
`captainUserId: string | null`, `captainName: string | null` in
`lib/hq/types.ts`; `ProjectPatch` gained a `"captain"` kind in
`lib/hq/queries.ts`.

### External configuration still required, task T4.4

None added.

### What changed, task T4.5

The reads: `leaderboard(db, hackathonId, viewerUserId?)`,
`currentCaptainOfProject(db, projectId)`, both new in `lib/hq/captains.ts`.
`/hq/captain` rewritten (`app/hq/(member)/captain/page.tsx`): the Captain's
own current assignments (`toCaptainAssignmentView` via `teamById()` where a
`BuilderTeam` exists, or a reduced `{ projectId, projectName }` fallback
card for an assignment to a CRM-only project with no self-serve team), the
leaderboard with the viewer's own row marked, then the unchanged Connect
Telegram notice. The Admin leaderboard: `getBuilderAdminData` gained
`captainLeaderboard`/`captainAssignments`; `components/hq/builder-admin.tsx`
gained a `CaptainLeaderboard` section (the ranked list, then the
unfiltered, admin-only per-project drilldown grouped by Captain, keyed by
project id). The team's own view of its Captain:
`lib/hq/member-teams.ts#memberTeamView` now calls `currentCaptainOfProject`
and feeds the result into `toMemberTeamView`'s existing third parameter, but
only on the verified-member path (`outcome === "allowed"`), never for an
account watching its own still-pending or rejected claim.
`app/hq/(member)/team/[id]/page.tsx` renders `team.captain.displayName` when
present (fix round 1 — see below).

**Decision — "active HQ projects" = `hq_project_statuses.counts_as_active`.**
Matches the existing product concept `getEventsWithOutputs`/
`attributeOutputs` already use to split "active" from "qualified".
`countAssignmentsByCaptain` (T4.4's) was extended with a join to
`hq_project_statuses` and `AND s.counts_as_active`: a project marked "red"
drops out of a Captain's leaderboard count but still appears in the admin
drilldown, which is unfiltered by status (Admin sees the full truth).

**Decision — zero-assignment Captains: two reads merged in application code,
not one combined query.** `leaderboard` combines
`countAssignmentsByCaptain(db, hackathonId)` with
`listCapabilityGrants({ capability: "captain", activeOnly: true })`, narrowed
immediately to `userId`/`userName` — `reason`, both operator ids, the grant
id and the timestamps never leave the function. The merge is driven by the
grant list: every active-grant account gets a row (`assignedCount` defaults
to 0), and a count-map entry for an id the grant list does not name is
silently dropped — which is what makes a revoked Captain disappear even if a
stray live assignment row outlived the revocation. `listCapabilityGrants` is
the one documented, operator-only reader of `hq_account_capabilities`;
writing a second query over that table from a different module was ruled
out.

**Decision — marking the viewer's own row without carrying an id.**
`CaptainLeaderboardView` gained `isYou: boolean`, computed by
`toCaptainLeaderboardView` comparing the row's raw `captainUserId` against a
`viewerUserId` parameter and keeping only the boolean — the id itself never
enters the returned object. `leaderboard()` takes `viewerUserId: string |
null = null` rather than an `Actor`, to avoid pulling `./actor` (and
therefore `member-auth.ts`) into `lib/hq/actions/captains.ts`'s
operator-scanned import graph. The Captain's own page passes `actor.id`;
Admin passes `null` explicitly.

**A fourth, load-bearing judgment call not explicitly asked for: the
CRM-only-project fallback.** T4.4's assignment service can target any
`hq_projects` row, including one with no `hq_project_onboarding` row (an
admin-created CRM entry). `CaptainAssignmentView`/`toCaptainAssignmentView`
require a `BuilderTeam`, which only exists for a project with an onboarding
row. Forcing every assignment through `teamById()` would have silently
dropped every CRM-only assignment from "your assignments" — a materially
misleading empty state for exactly the Captains assigned to such a project.
The page instead falls back to a minimal card naming just the project. This
is a genuine, named UX gap (no roster, no lead, no link for that assignment)
recorded as a phase 5 hand-off, not fixed here.

**Fix round 1 (commits `56fa7da`, `40458ad`, `2ee115c`, `e363fbe`), from a
privacy-lens review whose verdict was: no leak.** The reviewer traced the
rendered HTML, the RSC payload and every `href`/`key`/`title`/`aria-label`
and confirmed a Captain's browser receives other Captains' display names and
counts and nothing else. Two Important gaps, both in what was shipped rather
than in the design:

- **Important 1.** `MemberTeamView.captain` was populated but never
  rendered — neither the team page nor `BuilderTeamControls` read it, so
  the Captain's name reached the RSC payload as an unused prop and was shown
  to nobody. Fixed by rendering `team.captain.displayName` on the team page.
- **Important 2.** `tests/hq/captain-page.test.ts` (the real-database
  acceptance test) seeded both fixture projects with a bare
  `hq_projects` row and no `hq_project_onboarding`, so every assertion ran
  through the reduced fallback card and the "no rival Colosseum link" regex
  was vacuous — no fixture project had a `projectUrl` at all. Fixed by
  giving both fixture projects real onboarding rows (roster member, lead
  username, a Colosseum URL) under separate owner accounts, so the no-leak
  assertions became genuinely falsifiable, plus a third, deliberately bare
  project to keep the fallback branch explicitly covered on its own.

Four bundled minors: the "no Server Action exposes these reads" scan widened
from `lib/hq/actions` to the whole repo (`app/` and `lib/`, plus every
`app/**/route.ts`, which needs no `"use server"` directive to be reachable) —
22 such files confirmed, none referencing the new reads; the Admin
drilldown's lead-in sentence now explains why its count can differ from the
ranked leaderboard above it (the drilldown is unfiltered by
`counts_as_active`, the leaderboard is not); drilldown project rows keyed by
project id rather than name; a comment documenting the deliberate duplicate
`listCapabilityGrants` read (once directly for `BuilderAccount.captain`,
again inside `leaderboard()` for the zero-assignment merge) rather than
threading a shared parameter, since `leaderboard()`'s own narrowing of the
grant row is what makes it safe to hand to a Captain's own page unchanged.

**Deferred, per the reviewer's own instruction.** `app/hq/(member)/captain/page.tsx`'s
one `teamById()` call per assignment (no batched multi-id lookup) — outside
the plan's indexed-aggregate constraint, which governs counts, not this
per-assignment read; left for phase 5 to batch if a Captain's list grows.

### Checks passed, task T4.5

`tests/hq/captains.test.ts`, `describe("leaderboard")`: "carries only rank,
display name, assigned count and the isYou marker — no id, project name or
link"; "orders by assigned count descending, then display name ascending
for ties, with a zero-assignment Captain falling to the bottom on its own —
no second rule needed"; "does not count an ended assignment or another
edition's assignment"; "drops a revoked Captain entirely, even one whose
live assignment row a bare revokeCapability call (without
clearCaptainAssignments) left standing"; "includes an eligible Captain with
no current assignment"; "marks only the viewer's own row, and marks none
when there is no viewer". `describe("currentCaptainOfProject")`: "returns
the current Captain's id and name, or null while none is assigned".
`describe("the T4.5 reads are not exposed as a Server Action or a route
handler")`: "finds no reference to leaderboard, listAssignments or
currentCaptainOfProject in any Server Action module or app/**/route.ts".
`describe("countAssignmentsByCaptain")` gained "excludes a project whose
status does not count as active (plan section 3's 'active HQ projects')".

`tests/hq/view-models.test.ts`, `describe("toCaptainLeaderboardView")`:
"carries rank, display name, assigned count and isYou — never the raw
captain id it was given"; "marks isYou false for a different viewer, and for
every row when there is no viewer at all".

`tests/hq/member-actions-authz.test.ts`, `describe("the team page")`: "shows
the team its assigned Captain's display name with no contact (task T4.5),
and no Captain again once unassigned"; "shows no Captain to the account
watching its own still-unverified claim: only a verified team's own view is
populated".

`tests/hq/member-shell.test.ts`, `describe("the captain page")`: "is not
found without the capability, whatever else the account holds"; "sends a
signed-out visitor to sign in with the captain URL as the destination";
"shows the empty state and the Connect Telegram hint for a captain without a
Telegram identity"; "drops the hint once Telegram is linked"; "reads the
current edition once, and asks its two data reads for exactly the signed-in
Captain's own id"; "renders the Captain's own assignment and the
leaderboard, marking their own row, with no other project's name".

`tests/hq/captain-page.test.ts` (new, real-PGlite integration, not mocked):
"renders for a Captain, showing only that Captain's own assignments — both
the full team card and the CRM-only fallback card"; "leaks no other
Captain's project name, roster, lead or Colosseum link — names and counts
only on the leaderboard" (this is the acceptance check's own wording — the
regex is anchored to a Colosseum URL the seeded fixture actually carries,
after fix round 1); "is not found for a member without the Captain
capability, even one the leaderboard names"; "shows the other Captain at
zero once their own assignment ends, and drops them entirely once revoked".

`tests/hq/builders-admin.test.ts`, `describe("Captain leaderboard in Admin
(task T4.5)")`: "adds the edition-scoped leaderboard and the admin-only
project drilldown, and never leaks another edition's Captain or project
into them"; "excludes a not-active-status project from the count (but not
from the drilldown), includes an eligible zero-assignment Captain in stable
name order, and drops a revoked Captain entirely".

Full suite at `e363fbe` (fix round 1 complete, phase 4's final commit): 953
tests in 44 files, `tsc` clean, lint unchanged (0 errors, 18 pre-existing
warnings), `npm run build` passing (`/hq/captain`, `/hq/team/[id]` and
`/hq/admin` all listed as dynamic routes).

### Blocked or deferred, task T4.5

The CRM-only-project fallback (above) — a real, minor UX gap flagged for
phase 5 to decide deliberately rather than rediscover. The un-batched
`teamById()` loop on `/hq/captain` — deferred by the reviewer explicitly.

### Changed interfaces, task T4.5

`lib/hq/captains.ts`: `leaderboard(db, hackathonId, viewerUserId?: string |
null): Promise<CaptainLeaderboardView[]>`; `ProjectCaptain = {
captainUserId, captainName }`; `currentCaptainOfProject(db, projectId):
Promise<ProjectCaptain | null>`. `lib/hq/view-models.ts`:
`CaptainLeaderboardView` gained `isYou: boolean`;
`toCaptainLeaderboardView(row, rank, viewerUserId)`. `lib/hq/member-teams.ts#memberTeamView`
now populates `MemberTeamView.captain` on the verified-member path (`contact`
stays permanently `null` — no mechanism exists yet for a Captain to approve
one; a future phase adding that is a new `TeamCaptainView.contact` writer,
not a T4.5 concern). `lib/hq/builder-store.ts` gained
`selectCurrentHackathonId` (a shared helper `BuilderStore#currentHackathonId`
and `syncAccount` both now call, replacing a duplicated inline copy in the
latter).

### External configuration still required, task T4.5

None added.

### Phase 4 summary and acceptance checklist

**What changed and which migrations apply.** A Captain invitation service
(bearer-token links, one-use or multi-use, with expiry and capacity), the
`/hq/invite/<token>` exchange-and-continuation flow that spends no slot on a
preview, a failed signup or a repeat visit, an assignment service with a
documented lock order and conflict checks (a participant can never be made
Captain of their own team, whether through the acceptance race, the claim
race, or a mismatched-username roster), a revocation cascade that clears a
revoked Captain's assignments inside the same transaction as the grant's own
revocation, and a private leaderboard (Admin and each Captain see it,
scoped so a Captain never learns another Captain's project identities).
Migrations, both additive and applied by `hq:migrate` in the usual order:
`hq_captain_invitations`, `hq_captain_invitation_redemptions` and
`hq_captain_assignments` in `scripts/hq/builder-schema.sql` (T4.1), reset
classification for all three, and two index-predicate corrections (T4.1 fix
rounds 1 and 2 — both converge to permanent no-ops after the first real
`hq:migrate` run; see "What changed, task T4.1" above for why the second
round exists). T4.2 through T4.5 added no schema.

**Acceptance checklist.** The plan's five phase 4 acceptance bullets, quoted
verbatim, each with the test that proves it or the honest limit of what is
proven.

1. "One-use and multi-use links obey expiry and capacity under simultaneous
   redemption." **Passed for expiry and capacity arithmetic; "under
   simultaneous redemption" is proven by arithmetic and a source-level lock
   guard, not by true concurrent interleaving.**
   - Expiry and capacity: `tests/hq/captains.test.ts` "a one-use link: the
     first acceptance grants, a second distinct account is refused as full"
     and "a multi-use link honours its exact capacity"; "revoked and expired
     links refuse redemption without touching an existing grant"; the bounds
     themselves: `tests/hq/migration-order.test.ts` "refuses a non-positive
     max_redemptions" (the schema `CHECK`) and `tests/hq/captains.test.ts`
     "defaults capability to captain and validates maxRedemptions and
     expiry" (the service's own `MAX_REDEMPTIONS`/`MAX_VALIDITY_DAYS`
     bounds).
   - "Under simultaneous redemption": `tests/hq/captains.test.ts` "overlapping
     acceptance calls never exceed capacity, however many arrive at once"
     (five `Promise.all`-issued acceptances against a two-seat invitation,
     asserting exactly 2 granted and 3 full). **Stated honestly, as the
     test's own name and comment now say after fix round 1: PGlite's
     single-connection promise queue serializes every call the moment each
     transaction opens, so this proves the capacity arithmetic is correct
     for some commit order, not that two truly concurrent callers cannot
     interleave before either commits.** The actual safety guard — the row
     lock — is proven present, not merely reasoned about, by a separate
     source-level regression test in the same file, "locks the invitation
     row for the whole decision — a regression guard, since PGlite's
     serialized test pool cannot itself prove concurrency safety", which
     asserts the exact `FOR UPDATE` SQL text is still in
     `lib/hq/captains.ts`. The equivalent pair exists for assignment
     capacity: "two Promise.all-issued assignCaptain calls for the same
     never-before-assigned project settle to one current row — proves
     sequential safety only, the same thing the reassignment test already
     proves" (both calls return `assigned`; this exercises the ordinary
     reassignment path under PGlite's forced ordering, not the capacity
     guard itself) plus "the ON CONFLICT DO NOTHING guard itself: a second
     current-row insert for the same project is silently refused at the
     database level, never a raised constraint violation" (a direct
     database-level proof of the actual guarantee for the one case no lock
     covers) and "locks the
     candidate's active grant, the project's onboarding row (if any) and the
     current assignment row for update" (the source-level lock guard for
     every other case).
2. "Link previews, failed signup and repeat acceptance do not spend slots."
   **Passed.**
   - A preview (a GET, or a token read with no acceptance): `tests/hq/captains.test.ts`
     "changes nothing when read twice in a row — modelling a link preview
     immediately followed by a real visit" (`readCaptainInvitationByToken`);
     `tests/hq/invite-exchange.test.ts` "consumes nothing for a valid token,
     called twice — a link preview, then a real visit" and `tests/hq/invite-route.test.ts`
     "consumes nothing, exchanged twice for the same token — a link preview,
     then a real visit" (the same property through the real route handler).
   - A failed signup: `tests/hq/invite-accept-action.test.ts` "a failed
     sign-up followed by a successful one consumes exactly one slot — the
     acceptance check the plan names directly" — this is the plan's own
     named check, driven through the real member-gated action, not just the
     bare service call.
   - Repeat acceptance: `tests/hq/captains.test.ts` "repeat acceptance by the
     same account is idempotent and consumes no second slot" and "a replay
     after an admin revoked that account's grant does not re-grant it" (the
     resurrection-prevention case — a revoked grant cannot be reinstated by
     replaying an already-consumed redemption); `tests/hq/invite-accept-action.test.ts`
     "grants Captain to a verified, signed-in account, then leaves a second
     acceptance a no-op that consumes no slot" (through the action).
3. "Link revocation and Captain revocation have their documented separate
   effects." **Passed.** `tests/hq/captains.test.ts` "has separate,
   non-overlapping effects from Captain revocation: stops future redemption
   only, touches neither an existing grant nor an existing assignment" and
   "the reverse: Captain revocation (and its cascade) clears the assignment
   and touches no invitation" — both directions, in the same file. The
   cascade itself: "revoking a grant and clearing its assignments are one
   transaction: forcing the clear's own audit write to fail leaves the grant
   active and the assignment live" (service-level atomicity, over
   `pgliteBuilderDatabase`, the same composition the action uses) and
   `tests/hq/builders-admin.test.ts` "shows the affected project count
   before a revocation and clears the assignment in the same action" and
   "renders the real assignment count in the revoke confirmation copy, and
   the grant-side copy when there is none to lose" (the action-level count
   and cascade, through the real `revokeCaptainCapability`). **Split
   deliberately across two levels** because the Admin test harness's nested
   savepoints (both named `"action"`) cannot correctly model a
   `builderDatabase().transaction()` call nested inside another one the way
   production's real `pg` client does; the service-level test uses the
   production-shaped composition instead, and the action-level test is kept
   to the successful, count-matching case rather than claimed to prove
   atomicity it cannot.
4. "A participant cannot Captain their own team, including under concurrent
   requests." **Passed for every static ordering the tests can construct;
   "under concurrent requests" carries the same PGlite-serialization caveat
   as bullet 1.**
   - Static conflict: `tests/hq/captains.test.ts` "a verified team member
     cannot be assigned to their own team — the owner case" and "— the
     joined-member case"; "a roster identity linked to the candidate's
     account blocks assignment even without a verified HQ membership"; "a
     project's own owner is a conflict even before verification — the window
     loadTeamMembership alone misses"; "a claimant absent from the imported
     roster (or case-mismatched against it) is still a conflict, never
     needs_review" (the fix-round-1 gap closure — this is the case the
     original submission missed); "never compares display names: an
     unclaimed roster row whose name matches the candidate is still only
     'needs review', never a silent conflict or a silent pass" (the negative
     case the plan warns against separately).
   - The two race directions, both through commit ordering rather than true
     interleaving (stated in the test file's own header comment):
     `tests/hq/builder-onboarding.test.ts` "ordering 1 (assignment first): a
     Captain already assigned to a project cannot then join it through a
     team invite", "ordering 2 (membership first): a team member who already
     joined a project cannot then be assigned as its Captain" and "the
     'claim' path: a Captain already assigned to a pending project cannot
     then claim it as its verified owner". The lock actually being held,
     rather than only the outcome, is proven by
     `tests/hq/captains.test.ts`'s `describe("the membership-acceptance lock
     order (lib/hq/builder-store.ts)")` → "redeemInvite and importTeam lock
     the same hq_project_onboarding row assignCaptain locks, and check
     hq_captain_assignments before admitting a member or a verified owner —
     a regression guard for the shared lock order" (a source-level
     assertion, the same technique used for bullet 1's `FOR UPDATE` guards).
5. "Captains cannot inspect other Captains' teams through leaderboard APIs
   or direct links." **Passed.**
   - Through the leaderboard API: `tests/hq/captains.test.ts` "carries only
     rank, display name, assigned count and the isYou marker — no id,
     project name or link" and `tests/hq/view-models.test.ts` "carries rank,
     display name, assigned count and isYou — never the raw captain id it
     was given" (the mapper itself never emits an id, at the type and the
     serialized-JSON level).
   - Through the rendered page and its RSC payload: `tests/hq/captain-page.test.ts`
     "leaks no other Captain's project name, roster, lead or Colosseum link —
     names and counts only on the leaderboard" — the real, unmocked acceptance
     test, against a real assigned project with a real roster and a real
     Colosseum URL under a *different* owner account, so the negative
     assertion is genuinely falsifiable (fix round 1 closed the gap where
     the original version of this test seeded no `projectUrl` at all and
     therefore could not have caught a leak); "is not found for a member
     without the Captain capability, even one the leaderboard names" (the
     gate holds independently of what the leaderboard shows about them).
   - Through a direct link: no route accepts a `captainUserId` or a project
     id scoped to another Captain — `tests/hq/captains.test.ts` "finds no
     reference to leaderboard, listAssignments or currentCaptainOfProject in
     any Server Action module or app/**/route.ts" (a repo-wide static scan,
     widened in fix round 1 from `lib/hq/actions` alone to every
     `"use server"` module and every `app/**/route.ts`). The Admin drilldown,
     which does carry every project's Captain, has its own operator gate,
     independent of the Captain path: `tests/hq/builders-admin.test.ts`
     "adds the edition-scoped leaderboard and the admin-only project
     drilldown, and never leaks another edition's Captain or project into
     them".

**Two limits that apply across the checklist above, stated once rather than
repeated at each bullet.** PGlite (`tests/hq/helpers/db.ts`) serializes
whole transactions on one connection, so nowhere in phase 4 is "simultaneous"
or "concurrent" proven by true interleaving; every such claim is proven by a
combination of (a) capacity or outcome arithmetic under PGlite's forced
sequential ordering, (b) source-level assertions that the actual lock
(`FOR UPDATE`) or database guarantee (`ON CONFLICT DO NOTHING`, a partial
unique index) is genuinely present in the code, and (c) both possible commit
orderings tested separately where a race has two sides. And **nothing in
phase 4 is browser-verified**: every check above runs at the route-handler,
Server Action, service or database level. The one item this leaves
genuinely open is recorded under "Blocked or deferred, task T4.3" above and
repeated in `docs/hq/manual-setup.md`: the `Referrer-Policy`/`X-Robots-Tag`
headers for `/hq/invite/:path*` are asserted at config level only, and
confirming they land on the served redirect response needs a manual
`curl -I` against a running dev server.

**Blocked or deferred out of phase 4, with the phase that owns each.**

- The CRM-person-link race between `correctPersonMatch` and `assignCaptain`'s
  conflict check: **phase 3** (unreachable before phase 3 populates real
  `person_id` values on roster rows).
- The CRM-only-project fallback on `/hq/captain` (a Captain assigned to a
  bare CRM project sees a name only, no roster, no contact, no link), and
  the un-batched `teamById()` loop: **phase 5**, named explicitly rather than
  left to be rediscovered.
- `TeamCaptainView.contact` stays permanently `null`: no phase owns this
  until a future phase gives a Captain a mechanism to approve a contact for
  their team.
- A project deleted concurrently with an assignment to it surfaces a raw
  foreign-key violation rather than a typed outcome — a pre-existing gap
  across operator project actions generally, not newly introduced.
- The `Referrer-Policy`/`X-Robots-Tag` manual `curl -I` check: an owner
  action, in `docs/hq/manual-setup.md`.

**Changed interfaces and external configuration.** See the five per-task
"Changed interfaces" sections above; the phase-3-and-phase-5 shortlist is in
`docs/hq/contracts.md` under "Handoff to phase 3". Phase 4 added no
environment variable.

### Live API verification, after the phase 3 commits

The phase 3 work above was built entirely against the recorded fixtures.
Prompted by the owner, the adapter was then run against the **live** public
API on 2026-09-14 (bounded, read-only, unauthenticated: one project of the
current edition, one of Frontier, the directories list and one listing page).
It found two real bugs and four facts, all now handled. Full structural
detail is in `tests/hq/fixtures/colosseum/README.md` under "Re-checked live
on 2026-09-14"; no live value was copied into a fixture.

**Two bugs, both of which would have shipped:**

1. **`sort` is required on `GET /api/projects`.**
   `fetchEditionSubmissionWindow` did not send it, so every submission-window
   read would have failed with 400 `BAD_REQUEST` — surfacing as
   `SOURCE_REJECTED`, a plausible-looking "Colosseum refused that request"
   that would have looked like an upstream problem rather than our own.
   Fixed by sending `sort=NAME`; `tests/colosseum-api.test.ts` now asserts the
   exact request URL, so the parameter cannot be dropped again. The
   2026-09-13 note recorded that sorting *is* `NAME` or `RANDOM` and that
   `sortApplied` came back in the envelope; neither said the parameter was
   optional, and the fixture — a response — could not have caught it. This is
   the class of bug a fixture cannot find.
2. **One malformed listing row destroyed the whole edition's window.** A real
   Frontier project carries the slug `""or""or`, which `slugSchema` rejects,
   and `listingSchema` validated every row — so a single pathological project
   anywhere in the page made `fetchEditionSubmissionWindow` return
   `INVALID_RESPONSE` for the entire edition. The window read never looks at a
   row, so `listingSchema.projects` is now `z.unknown()`; the detail endpoint,
   which imports actually use, keeps strict validation. A regression test
   drives a page containing that exact slug plus a nonsense row.

**Four facts:**

3. **The external edition is verified: id `7`, slug `crypto-worlds-fair`,
   "Crypto World's Fair".** A live project of that edition carries it in its
   own `hackathon` block. Recorded in `docs/hq/manual-setup.md` 2.6 and L11;
   it stays operator data typed into Admin, never seeded, so no code changed.
   The previous note ("plausible, but unproven, that 7 is the World's Fair")
   is retired.
4. **`DRAFT_SIGNAL_CONFIRMED` flipped to `true`.** The pair the constant was
   waiting for was observed through the same unauthenticated detail endpoint:
   an in-flight edition-7 project returned `"submittedAt": null` — present,
   not absent — and a finished edition-6 project returned a real timestamp. A
   checked project with no submission now shows a red **Not submitted**. The
   caveat is recorded at the constant and in L13: the two projects are from
   different editions, because the current edition's disabled directory makes
   a same-edition pair unobtainable. Two tests assert which way the constant
   is set, so flipping it back is a visible change.
5. **`projectCompletion` is not returned by the public detail endpoint at
   all**, on either project — contradicting the fixture and the earlier note
   that it is "returned by the detail endpoint only". The schema already had
   it `nullish`, so nothing broke, but in practice `completion_is_complete`
   is always NULL and the "Colosseum readiness" line on the team page never
   renders. Corrected in the fixtures README and in `contracts.md`.
6. **Roster `avatarUrl` was null for every member observed**; the picture is
   an `avatarPresetId` HQ does not read. So `hq_project_members.avatar_url`,
   added by this phase, is usually NULL. Kept — it costs nothing and is
   populated when a member does have a URL — but it is not the roster imagery
   the plan's Imported fields table implied. The detail response also carries
   a top-level `presentation` block and `bio`/`publicRole` per member, all of
   which survive unread inside `raw`.

Everything above is a small, contained change: two files of adapter logic,
one constant, three tests, and documentation.

### Verification run for phase 4, task T4.6

First run at commit `e363fbe` (the last commit to touch source, before this
documentation task's own commits). Re-run and confirmed byte-for-byte
identical at `9d7009a` (task T4.6's first documentation commit) and again at
`eebf1f6` (this task's fix round 1). Both re-runs matter because a
documentation task can still break `tsc`/lint/build indirectly (a broken
code fence, a file moved into the wrong place) even though it should not —
this is that check having actually been done, not assumed. No source, schema
or test file was touched by either documentation commit (`git show --stat`
on both shows only the three `docs/hq/*.md` files), so the numbers hold at
every commit from `e363fbe` onward, including any further documentation-only
commit on this branch after `eebf1f6`.

- `npm run lint`: 0 errors, 18 warnings, all pre-existing and all in
  `public/deck/deck-stage.js`. Unchanged from the phase 0 baseline and from
  every task this session.
- `npx tsc --noEmit`: clean, no output.
- `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test`: 953 tests in 44
  files, all passing. Phase 2 closed at 754; phase 4 added 199.
- `env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm run build`: passes. Every
  `/hq` route compiles; `/hq/invite/[token]` (Route Handler) and
  `/hq/invite/continue`, `/hq/captain` are listed as distinct dynamic routes.

## Phase 3, self-service imports, joining, enrichment and admin record management

Implemented in one session on branch `hq-captains-phases-0-2`, on top of
phase 4. This phase was rewritten by the owner on 14 September 2026, and
section 2's "Team import and joining" plus phase 3's "The import gate,
joining and error reporting" and "Admin record deletion" are the authority
for everything below; where an earlier draft of the plan contradicts them,
they win.

### What changed

**The import gate (`lib/hq/project-import.ts`, new).** An import is accepted
when, and only when, the fetched project satisfies both halves of the owner's
rule: `project.country` is Netherlands, and `project.hackathonId` equals the
external edition id an admin configured in `hq_hackathon_onboarding`. Neither
value is hard coded. `gateProject(project, edition)` is the pure decision, so
the two rules are testable directly against the recorded fixtures;
`importColosseumTeam` is the entry point the member action calls, and it
checks the edition mapping **before** any network call so that an
unconfigured edition — HQ's own state — can never look like a Colosseum
outage. There is no ownership-proof challenge, no pending state, no approval
queue and no teammate-selection step: a Dutch project in the current edition
goes in from the pasted link alone.

**The failure taxonomy (`lib/colosseum-api.ts`, `lib/colosseum-schema.ts`).**
The adapter no longer collapses every non-2xx other than 404 and 429 into
`UNAVAILABLE`. `ColosseumErrorCode` now separates `NOT_FOUND`,
`RATE_LIMITED`, `TIMED_OUT`, `UNREACHABLE`, `INVALID_RESPONSE`,
`SOURCE_REJECTED` (a 4xx whose body carries Colosseum's own `code`/`message`,
which is what finally tells "directory disabled" apart from "unknown
edition") and `UNAVAILABLE`, and each carries `sourceCode`/`sourceMessage` as
data. Nine member-facing outcomes each get their own wording
(`IMPORT_REFUSAL_MESSAGES` plus the adapter's own messages); the upstream text
is never one of them and is never rendered as markup — it is stored on the
project's row in `source_error_message` for operators. Field names moved into
one schema module (`lib/colosseum-schema.ts`) so a renamed upstream field is a
one-file change.

**The already-imported case.** Its own outcome, routed to help rather than to
a retry: `components/hq/builder-onboarding.tsx` renders the Superteam NL
Telegram group as a **logo control with an accessible name**
(`IconTelegramLogo`, `fill="currentColor"`, `aria-label`), never a bare URL
and never the raw invite string as link text, and says nothing about who
imported the team or who is on it. The URL and its accessible name live in
`lib/hq/community.ts`, written once.

**The `verification` decision (the first of the plan's four named
consequences).** The column stays and a successful import writes `'verified'`.
That is the smaller of the two options the hand-off offered: every existing
reader — `loadTeamMembership` in `lib/hq/authz-sql.ts`, and through it
`authorizeProjectAction`, `memberTeamView`, `updateTeam`, `createInvite` and
`redeemInvite` — keeps working unmodified, and no membership check is left
that no import can satisfy. What is removed is the *step*, not the column.

**The dead review surface (the second consequence).** `reviewBuilderProject`
is deleted from `lib/hq/actions/builders-admin.ts`; the verification controls
and the proof-comment line are gone from the "Imported teams" panel;
`hq_project_onboarding.proof_comment_id` and `proof_author_id` are dropped;
and `hq_project_challenges` is dropped entirely, with its entry removed from
`scripts/hq/reset-statements.ts`. A pre-existing `'pending'` or `'rejected'`
row from before this change is not auto-approved and not hidden: the team page
tells that account it is an old import request that never became a team, and
an admin clears it with the new Delete team control. In practice there are
none — public signup has not been released.

**Joining by link.** `createInvite` is unchanged in shape (one link per
unclaimed roster seat, issued by the team's own importer, previous link for
that seat retired) but is now presented as a **link**: `joinLink(code)` in
`lib/hq/member-routes.ts` builds `/hq/join/<code>`, and
`app/hq/(member)/join/[code]/page.tsx` is the page it points at, member
gated, which looks the seat up and asks for confirmation — arriving redeems
nothing. `parseJoinCode` accepts the whole pasted link or a bare code and
survives a trailing slash, surrounding or internal whitespace, an appended
tracking query and a fragment; it runs on the client for the form and again
on the server, which is the check that counts. `store.invitation` now returns
a typed lookup rather than throwing one shared message, so invalid, expired,
used and wrong-edition each get their own wording (`JOIN_LINK_MESSAGES`) and
**none of them names the team**. `/hq/join/:path*` gained the same
`Referrer-Policy`/`X-Robots-Tag` headers the Captain invitation subtree has,
for the same reason.

A self-service import deliberately claims **no** roster seat for the
importer: there is no teammate-selection step to claim one with, and the
plan's "one step" leaves no room for one. The importer is the project's owner
(`owner_user_id`), which is what membership is read from, and their own
roster seat is simply one more unclaimed seat with a join link they can open
themselves. The team page says so.

**The CRM merge (contracts note 1).** The roster import creates or reuses a
person by normalized Colosseum username through `ensurePersonForRosterMember`
— never by display name — and gives that person a People card in the edition
only when it has none (`hq_people_person_idx`, one card per person per
edition, guarded on every write). When that person's human later joins with a
link, `redeemInvite` runs the **merge** branch of `correctPersonMatch` inside
its own transaction, exactly as the hand-off specified: cards and roster rows
move onto the account's own person, the provisional username moves with them,
the merged person is deleted, `person.match_corrected` is recorded. No second
link path was added and `linkPersonToAccount` is not used for this case.

**The snapshot.** `hq_project_onboarding` gains the normalized fields beside
its bounded raw snapshot: category, tracks, X handle, website, repo, the four
material links, image, the external edition id/slug/name, `submitted_at`, the
two `completion_*` readiness fields, `submission_status`, and
`source_status`/`source_checked_at`/`source_error_code`/`source_error_message`.
Existing rows are backfilled from the raw payload they already hold, one
guarded statement per field, matched by the row's own snapshot rather than by
name. `hq_project_members` gains `avatar_url`.

**The submission signal, in one function.**
`lib/hq/colosseum-snapshot.ts#interpretSubmission` is the only writer of
`submission_status`. A non-null `submittedAt` is Submitted. A null reads as
**Not checked**, not "Not submitted", because `DRAFT_SIGNAL_CONFIRMED` is
`false`: `submittedAt` was non-null on every project ever observed live and no
draft was reachable, so "null means draft" is an assumption HQ will not put a
red badge behind. The constant's comment and manual-setup item L13 both name
exactly what would confirm it. `projectCompletion.isComplete` is not an input
to that function at all. `fetchEditionSubmissionWindow` is the one function
that reads `hackathons[].projectSubmissionEndDate`.

**Refresh** (`store.refreshTeam`, `refreshColosseumTeam`) is separate and
idempotent. It rewrites the snapshot and upserts roster identities; it never
deletes a roster row, never changes `owner_user_id`, `verification`, `stage`,
`lead_username`, notes or a Captain assignment, and never overwrites a
`person_id` an operator corrected. A failed check records `source_status`,
the HQ error code and Colosseum's own message, and leaves the last known
submission status and last successful check time alone — green never turns
red because a request failed.

**The fallback image.** `docs/plans/assets/hq-project-fallback.png` copied to
`public/images/hq/project-fallback.png`, referenced through one constant, and
rendered by `components/hq/builder-project-image.tsx` on the team page, the
Captain's assignment cards and the Admin list. Deliberately a plain `<img>`
with an `onError` fallback rather than `next/image`: routing a third-party
CDN through `next/image` would mean allow-listing that host and having this
application fetch and re-serve arbitrary remote bytes, which the plan rules
out. The `<img>` lint warning is suppressed at the line with that reason.

**Admin deletion** (`lib/hq/record-deletion.ts`, new). Delete team (the
"Imported teams" panel) and Delete person (People) are operator-only,
edition-scoped through the usual resolution, audited (`project.deleted`,
`person.deleted`), and each runs in **one transaction** with the real counts
read before the destructive step for the confirmation and again inside the
transaction for the audit metadata. Deleting a person removes their People
card and this edition's enrollment, deletes the CRM person only when that was
its last card anywhere, detaches roster rows rather than removing them, and
**never touches the HQ account**. The Projects board's pre-existing
`deleteProject` now calls the same function, so there is one deletion
implementation rather than two that could drift.

**The Captain-conflict race (the fourth consequence).** Decided: **lock**.
`checkCaptainConflict` now takes a `FOR UPDATE` on the CRM person rows this
project's roster points at, in id order, in a statement of its own (Postgres
refuses `FOR UPDATE` on the nullable side of an outer join). It is lock-order
step 3b. Why locking rather than accepting the race: the state it can land in
is a product invariant the plan states unconditionally ("A Captain cannot be
assigned to a team they participate in"), and one extra statement on a path
that already holds three locks is a cheap way to close it. It cannot
deadlock against `correctPersonMatch`, which locks one person row by id and
never reaches for the capability, project or assignment locks this
transaction already holds.

**Also.** The hard-coded `HACKATHON_ID = 6` is gone from
`lib/hq/colosseum-interest.ts` (contracts note 3): the public interest form
now resolves the current edition with the same server-side pick every other
surface without a selector uses, and files a submission under the next
edition rather than silently dropping it when the current one is archived.
`scripts/hq/seed.ts`'s comment claiming its `id` is "Colosseum's hackathon
id (World's Fair is 6)" is corrected — it is HQ's own internal id.

### Which migrations apply

All in `scripts/hq/builder-schema.sql`, applied by `hq:migrate` in the usual
order, all idempotent single statements through the splitter:

- `ALTER TABLE hq_project_onboarding ADD COLUMN IF NOT EXISTS ...` for the 21
  snapshot columns. The two status columns carry their CHECK constraints
  **inside** the `ADD COLUMN IF NOT EXISTS`, not as a separate
  `DROP CONSTRAINT` / `ADD CONSTRAINT` pair: migration convention 8's
  reasoning about drop-then-create pairs applies to constraints exactly as it
  does to indexes, and a check attached to the column is skipped with the
  column on every later run.
- `ALTER TABLE hq_project_members ADD COLUMN IF NOT EXISTS avatar_url text`.
- `ALTER TABLE hq_project_onboarding DROP COLUMN IF EXISTS proof_comment_id`
  and `proof_author_id`; `DROP TABLE IF EXISTS hq_project_challenges`. All
  three are idempotent single statements and converge to no-ops.
- Fourteen guarded backfill `UPDATE`s from `raw`, each conditioned on the
  column still being NULL, so each matches nothing on a fresh database,
  nothing on a re-run, and never overwrites a later refresh or an operator's
  edit. `submission_status` is deliberately **not** backfilled.
- `scripts/hq/reset-statements.ts`: `hq_project_challenges` removed from
  `KEEP_TABLES` along with the table itself.

### Checks passed

Named tests, one per acceptance bullet.

| Acceptance bullet | Test |
|---|---|
| Full, partial, null-image and duplicate-link fixtures render correctly | `tests/hq/colosseum-snapshot.test.ts`: "keeps every queryable field of the full fixture", "imports a partial project, with every optional field missing", "treats an unusable image URL as no image", "shows a URL pasted into two fields once, naming both" |
| A project imported twice does not create duplicate teams or People identities | `tests/hq/builder-onboarding.test.ts`: "reports an already-imported project rather than creating a second team", "refuses a simultaneous second import", "gives one People card per person per edition, even when two teams share a roster member" |
| Refresh retains membership claims, contacts, notes and Captain assignment | `tests/hq/builder-onboarding.test.ts`: "updates the snapshot and adds new roster members without touching HQ state", "keeps a member who left the Colosseum roster, and their claimed HQ membership", "is idempotent" |
| A complete draft, confirmed submission, unknown state and network failure produce distinct correct behavior | `tests/hq/colosseum-snapshot.test.ts` ("the submission signal", five cases) and `tests/hq/builder-onboarding.test.ts`: "a failed check records the failure and keeps the last known submission status" |
| The fallback image works on desktop/mobile and on image loading failure | `tests/hq/colosseum-snapshot.test.ts`: "is in place under public/", "is used for a missing image and for one that fails to load". **Browser-verified: no** — see the limits below |
| A Dutch project in the current edition imports in one step, with no verification, approval or pending state anywhere | `tests/hq/builder-onboarding.test.ts`: "imports the project, its normalized snapshot, its roster and its People identities in one step" (asserts `verification: 'verified'` and a single call), "imports through the member action end to end" |
| Each of the nine failures produces its own distinct message, and none is generic | `tests/hq/builder-import-ui.test.ts`: "gives each refusal a distinct, actionable message", "keeps the transport failures apart from 'not found', each inviting a retry"; `tests/hq/builder-onboarding.test.ts`: "imports through the member action end to end, and answers each Colosseum failure with its own reason"; `tests/colosseum-api.test.ts`: "classifies HTTP %s as its own code", "carries Colosseum's own code and message as data" |
| Importing an already-imported team says so, offers the Telegram group as a logo control with an accessible name, and reveals nothing about who imported it | `tests/hq/builder-import-ui.test.ts`: "renders the Telegram group as a logo control with an accessible name, never a raw URL, and names nobody" |
| A join link admits exactly one teammate, survives a trailing slash, whitespace and an appended query, and fails distinctly when invalid, expired, used or from another edition, without naming the team | `tests/hq/builder-onboarding.test.ts`: "accepts a whole pasted join link, a bare code and a link with a tracking query or trailing slash", "redeems once", "permits only one successful concurrent redemption", "refuses %s with its own reason, naming nothing about the team", "does not let one HQ account claim two seats", "merges the roster person into the joining account's own person"; `tests/hq/builder-import-ui.test.ts`: "the join link" |
| Deleting a team and deleting a person each remove or detach every dependent row in one transaction, are audited, confirm real counts beforehand, and leave the account intact | `tests/hq/builders-admin.test.ts`: "deletes a team with everything attached to it, in the selected hackathon only, and audits what went", "deletes a person's card without deleting their HQ account, and detaches what pointed at them", plus both entries in the "requires an operator session for %s" table |

Plus: `tests/hq/migration-order.test.ts` ("phase 3: the Colosseum source
snapshot and the removed challenge") applies the whole migration twice on a
fresh database and once more over a populated row, asserting every new column,
both drops, the CHECK constraints and the backfill's guard;
`tests/hq/captains.test.ts` pins lock-order step 3b and pins that
`importTeam`'s old Captain check is gone because the path it guarded is gone;
`tests/hq/invite-config-headers.test.ts` covers the `/hq/join` headers entry;
`tests/hq/colosseum-interest.test.ts` pins the removed constant's replacement.

Verification run at commit `c324269`: `npm test` 969 tests in 46 files
passing (phase 4 closed at 953); `npx tsc --noEmit` clean; `npm run lint` 0
errors and 18 warnings, all pre-existing and all in
`public/deck/deck-stage.js`, unchanged from the phase 0 baseline; `npm run
build` passes, with `/hq/join/[code]` listed as a distinct dynamic route.

### Blocked or deferred

- **Nothing in this phase is browser-verified.** Every check is at the
  endpoint, source or markup level. The fallback image on a real phone, the
  Telegram logo control's rendered size and the join screen's paste behaviour
  all want one manual pass.
- **The `Referrer-Policy`/`X-Robots-Tag` headers on `/hq/join/:path*`** are
  asserted at config level only, exactly like `/hq/invite/:path*` before them.
  Manual setup item L14; a `curl -I` against a running server is the check,
  and it was not run this session.
- **The draft submission signal stays unconfirmed.** Not submitted never
  shows. Manual setup item L13 names what would confirm it and which single
  constant to flip. Not resolvable from a checkout: the World's Fair
  directory is disabled, so no draft is reachable.
- **The listing client stops at the submission window.**
  `fetchEditionSubmissionWindow` is the one listing read this phase needed.
  Nothing pages the country subset or diffs submissions, because phase 9 —
  the "Dutch projects missing from HQ" discovery list — was removed by the
  owner, and nothing else in the plan asks for it.
- **A preferred team contact** ("Let the owner confirm a preferred team
  contact using the existing contact model, including a Telegram contact when
  available") is **not built**. The existing contact model here is
  `hq_builder_profiles.contact_email` (self-declared, already in place from
  phase 2) and `hq_people.contact`; what the plan asks for is a *team*-level
  preferred contact, which no table models and which no phase 3 acceptance
  bullet checks. Deferred rather than invented: it is one nullable column and
  one field on the team page whenever the owner wants it, and phase 6's team
  dashboard is the natural place. Called out here rather than left silent.
- **`hq_project_onboarding` rows with legacy `verification <> 'verified'`**
  have no path back to a usable team other than an admin deleting them.
  Correct under the new rules (there is no approval step to approve them
  with), and empty in practice, but stated so nobody looks for a control that
  does not exist.
- **The fallback image is 1.1 MB.** Works, cached after first load, but a
  smaller export would be better on a phone. Left to the owner (manual setup
  2.7) rather than re-encoding approved artwork unasked.
- **Phase 5's reporting rows do not exist yet**, so deletion cannot handle
  them. `lib/hq/record-deletion.ts` says so at the top, and the contracts
  hand-off tells phase 5 to extend both deletions rather than assume they are
  complete.
- **A refresh overwrites an operator's rename of an imported project.**
  `refreshTeam` writes `hq_projects.name` from the snapshot, which is what
  the plan's Imported fields table asks for (name, description and country
  are project details from the source; "editable HQ annotations remain
  separate"), but the Projects board's `updateProjectDetail` can also rename
  an imported project, and the next Check submission reverts that rename.
  Not a defect of either piece on its own, and not worth a pinning column
  before someone actually wants one — recorded so it is a known consequence
  rather than a surprise.

### Changed interfaces

- `lib/colosseum-schema.ts` (new, pure): every field name the API adapter
  reads, as zod schemas. `projectBodySchema`, `projectDetailSchema`,
  `listingSchema`, `listingHackathonSchema`, `errorBodySchema`.
- `lib/colosseum-api.ts`: `ColosseumErrorCode` widened and split (see above);
  `ColosseumApiError` gained `sourceCode`/`sourceMessage`; `isRetryable`;
  `ImportedProject` gained `category`, `tracks`, `twitterHandle`,
  `submittedAt`, `completion`; `fetchEditionSubmissionWindow` added;
  `fetchProjectComments`, `verifyProjectClaim`, `findProjectProof`,
  `ProjectChallenge` and `ProjectProof` **removed** with the challenge flow.
- `lib/hq/colosseum-snapshot.ts` (new, pure): `PROJECT_FALLBACK_IMAGE`,
  `SubmissionStatus`, `SUBMISSION_LABELS`, `DRAFT_SIGNAL_CONFIRMED`,
  `interpretSubmission`, `submittedOnTime`, `toSnapshotFields`,
  `groupedMaterials`.
- `lib/hq/project-import.ts` (new, server): `ImportFailureReason`,
  `ImportOutcome`, `importFailureFor`, `inviteRetry`, `gateProject`,
  `importColosseumTeam`, `refreshColosseumTeam`.
- `lib/hq/record-deletion.ts` (new, server): `TeamRemovalImpact`,
  `teamRemovalImpact`, `deleteTeamRecord`, `PersonRemovalImpact`,
  `personRemovalImpact`, `deletePersonRecord`.
- `lib/hq/community.ts` (new, client-safe): `SUPERTEAM_NL_TELEGRAM_GROUP`,
  `SUPERTEAM_NL_TELEGRAM_GROUP_LABEL`.
- `lib/hq/builder-types.ts`: `NETHERLANDS`, `isNetherlands`, `ImportRefusal`,
  `IMPORT_REFUSAL_MESSAGES`, `ImportRefusedError`, `JoinLinkRefusal`,
  `JOIN_LINK_MESSAGES`, `JoinSeat`, `JoinLinkLookup`, `BuilderTeamSource`;
  `BuilderTeam` gained `source` and its roster rows gained `avatarUrl`.
- `lib/hq/builder-store.ts`: `issueChallenge` and `challenge` **removed**;
  `importTeam(user, { hackathonId, project, projectUrl })` replaces the
  six-argument version; `importedProject`, `refreshTeam`,
  `recordSourceFailure` added; `invitation(code)` returns `JoinLinkLookup`
  instead of throwing.
- `lib/hq/member-routes.ts`: `/hq/join/` subtree, `joinLink`, `parseJoinCode`.
- `lib/hq/view-models.ts`: `MemberTeamView` and `CaptainAssignmentView` gained
  `source`; roster rows gained `avatarUrl`.
- `lib/hq/audit-sql.ts`: `project.imported`, `project.deleted`,
  `person.deleted` added to `AUDIT_EVENT_KINDS`.
- `lib/hq/types.ts`: `Person` gained `removal` (operator-only counts).
- `lib/hq/actions/builders.ts`: `previewBuilderProject`,
  `beginBuilderVerification` and `completeBuilderImport` **removed**;
  `importBuilderTeam` and `refreshBuilderTeam` added;
  `previewBuilderInvite` now takes a pasted link or code and returns a typed
  refusal. `lib/hq/actions/builders-admin.ts`: `reviewBuilderProject`
  **removed**, `deleteBuilderTeam` added. `lib/hq/actions/people.ts`:
  `deletePerson` added.
- `components/hq/builder-project-image.tsx` (new, client):
  `BuilderProjectImage`. `components/hq/builder-onboarding.tsx` gained
  `SubmissionBadge` and `TeamSourceDetails` and lost the preview/challenge UI.

### External configuration still required

Unchanged by this phase, with two additions: manual setup **L13** (confirm the
draft submission signal against a live submitted/unsubmitted pair, then flip
`DRAFT_SIGNAL_CONFIRMED`) and **L14** (`curl -I` the `/hq/join/<code>`
headers). Item **2.6**, the Colosseum edition mapping, is now what stands
between the owner and any import at all: until it is set in Admin, every
import answers "Superteam NL has not confirmed this hackathon's Colosseum
edition yet". Item **2.7** is done in code, with an optional smaller image
left to the owner.

## Phase 5, weekly reporting periods, entries, revisions, outcomes and privacy

Implemented in one session on branch `hq-captains-phases-0-2`, on top of
phase 3. The plan's Phase 5 section is the authority for everything below,
together with section 2's "Weekly reporting" and "Hackathon dates and final
submission" and section 5's privacy contract.

The goal of this phase is the model, not the screens: "establish a single
reliable reporting model before adding reminders". Phase 6 builds the
dashboards and the Server Actions that call this service, phase 7 the bot
handlers, phase 8 the reminder and closure jobs. **No Server Action and no
page was added here on purpose** — `docs/hq/contracts.md`'s standing rule 1
("a stub module is work with no user", "a stub route handler would be a live
endpoint") applies exactly to an action with no screen behind it, and every
entry point phase 6 needs is already a typed function on the service.

### What changed

**The period generator (`lib/hq/reporting-periods.ts`, new).** Pure, no
`server-only` and no database handle, following the `lib/hq/luma-sync-sql.ts`
pattern, so the plan's period table is asserted literally in a test including
its UTC instants. `generateReportingPeriods(schedule)` turns a campaign's
local `startDate`/`endDate`, its timezone, an optional final-period start and
a nudge weekday and time into consecutive windows. Each period carries both
readings the plan asks for: `startDate`/`endDate` are the **inclusive local
dates** a screen displays, `startsAt`/`endsAt` are **UTC instants with an
exclusive end**, and one period's `endsAt` is exactly the next one's
`startsAt`. The last period's exclusive end is local midnight on the day
*after* `end_date`, which is why **there is no fifth period beginning 12
October**: the campaign's final day sits inside the final period rather than
opening a new one. `zonedDateTimeToUtc` resolves a local wall clock to an
instant by guessing with the offset at the naive reading and correcting once
with the offset at the guess, which is exact for every real zone outside a
spring-forward gap; `addDays` is calendar arithmetic in UTC, so a clock change
moves the instant and never the date.

The merge rule is the plan's "explicit final-period start/merge setting":
every weekly period that would begin on or after `final_period_start_date`
becomes one submission-focus period running to the campaign's end, and a
weekly period the final start interrupts mid-week is truncated the day before
it. A final start outside the campaign is ignored rather than clamped, because
clamping would silently relabel every week, or none, on a typo.

**Six additive tables (`scripts/hq/builder-schema.sql`).** Documented in full
where they are created; read those comment blocks before touching
`lib/hq/reporting.ts`.

- `hq_reporting_config`, per edition. Deliberately thin: the reporting window
  is `hq_hackathons.start_date`/`end_date` and the timezone is
  `hq_settings.timezone`, both already operator-editable, and copying either
  here would be the competing source of truth the data contract forbids. What
  is left is what had no home: `final_period_start_date`,
  `official_submission_deadline` (for when Colosseum's own cutoff is earlier
  than HQ's window) and `nudge_weekday`/`nudge_time`, stored so phase 8 can
  change the reminder time without editing bot code.
- `hq_reporting_periods`, with `(hackathon_id, sequence)` unique. `sequence`
  is the period's identity, which is what lets a stored period be matched to a
  regenerated one field by field.
- `hq_reporting_eligibility`, one row per project: `eligible_from`,
  `paused_at`, and `enabled_by_user_id` (NULL for a self-service import, the
  operator for a manually tracked project).
- `hq_reporting_entries`. `author_kind`/`author_id` follow
  `hq_audit_events.actor_kind`/`actor_id` rather than a foreign key, for the
  same two reasons: an author may be a public account (a text id) or an
  operator (a uuid), which no single foreign key expresses, and the plan
  requires the **original author preserved even when an admin edits**, which a
  SET NULL on account deletion would quietly undo. `submitted_at` is the
  server's clock at first save and never moves. `version` is the optimistic
  token. `late` marks an entry added to a period that had passed. `voided_at`
  is moderation, never deletion.
- `hq_reporting_entry_revisions`, `UNIQUE (entry_id, version)`: one immutable
  row per version, version 1 being the content as first submitted, written in
  the same transaction as the insert or update it records. The invariant is
  `revisions == entry.version`, so "the previous version" is the preceding row
  and history can never be missing a step.
- `hq_reporting_outcomes`, `UNIQUE (period_id, project_id)`. `completed` is
  the factual on-time answer at close and is never rewritten; an admin
  correction writes `corrected_completed` beside it with a reason, so the
  effective answer is `COALESCE(corrected_completed, completed)` and the
  original stays readable. `captain_user_id` is the Captain at close, carried
  as history without a foreign key so a later reassignment cannot change what
  a period recorded.

**`loadEntry` (`lib/hq/authz-sql.ts`) is no longer a stub.** Only the body
changed, exactly as the hand-off specified: `Entry`, `CurrentAssignment`,
`entryAudience` and `canEditEntry` are untouched, and their phase 1
injected-fixture tests needed no change. The edition comes from the project
rather than a column of the entry's own, so an entry can never claim an
edition its project is not in. An **operator author is namespaced as
`operator:<id>`** on the way out: the only reader of `authorUserId` compares
it against a *member* actor's id, and the two id spaces are different tables,
so namespacing means an admin-authored sensitive note can never be read back
as a member's own however those spaces happen to overlap. A voided entry is
still returned, because whether an edit is refused for that reason is the
service's business, not an authorization fact's. The file-local `isProjectId`
became `isRecordId`, since it now also guards an entry id.

**The reporting service (`lib/hq/reporting.ts` and
`lib/hq/reporting-enrolment.ts`, new).** The contract names one module; it is
split in two for one reason, recorded in both headers: the store has to enrol
a team inside the import's own transaction, `lib/hq/reporting.ts` imports
`./authz` for the entry rules, and `./authz -> ./actor -> ./member-auth ->
./builder-store` is a cycle — the same one `./authz-sql` and
`./placeholder-email` were extracted to avoid. `reporting-enrolment.ts` holds
the schedule and eligibility, imports no `./authz` and takes no `Actor`, and
everything it owns is re-exported unchanged from `reporting.ts`, which stays
the one module a caller looks in.

- `readReportingSchedule` assembles the schedule from the records that already
  own each part, never from Colosseum. Colosseum's `projectSubmissionEndDate`
  is a separate external deadline, stored as `official_submission_deadline`
  when an admin records one, and it never moves HQ's window.
- `ensureReportingPeriods` reconciles stored periods with the schedule in one
  transaction, matching **by `sequence`, never by dates**: a one-day shift in
  the campaign window is then "three periods moved", not "four deleted and
  four created". A period that already holds an entry or an outcome, or that
  has been closed, is **never moved or removed** — it comes back as a
  `ReportingPeriodConflict` naming what it stores and what the schedule now
  says, which is the plan's "show affected periods before an admin changes a
  live schedule". `previewReportingPeriods` is the same computation with no
  writes, for that confirmation.
- `enableReporting`/`pauseReporting` own `hq_reporting_eligibility`. Enabling
  is idempotent and **never moves an existing `eligible_from`**, so
  re-enabling cannot erase the weeks a project was already accountable for,
  and resuming a pause leaves the original start alone. Entering reporting is
  also what makes the edition's schedule exist ("store period identities once
  reporting begins"), so the first team in an edition brings its periods with
  it. Neither takes an `Actor`: the presence of an `operatorId` is the whole
  difference between the import path (no event, since `project.imported`
  already records it) and an admin's (audited), and an `Actor` parameter would
  have pulled the member auth graph into a module the store imports.
- `createUpdate` authorizes through `authorizeProjectAction` with the
  **loaders bound to its own transaction** (`loadersOver`), validates and trims
  the body, resolves the period from the instant, and writes the entry and its
  version 1 revision together. `expectedPeriodId` is the plan's draft binding:
  a save whose bound period is no longer open is refused with
  `period_changed` and the period that is open now, so the caller asks before
  moving the text into a different week. An explicitly chosen past period is
  accepted and marked `late`, and completes nothing.
- Sensitive is authorized per project by reading the decision, not by
  re-deriving a rule: `via === "captain"` means "the project's current
  Captain and not one of its team members", because `authorizeProjectAction`
  checks membership first. An account that is a Captain elsewhere, posting on
  its own team, comes back `via: "member"` and cannot hide an update from its
  own teammates.
- `editUpdate` locks the row, checks `expectedVersion`, and on a mismatch
  returns the **current entry so the caller keeps the unsaved text**. A no-op
  save appends nothing. The original author, `submitted_at` and the period are
  never touched, so an edit is a correction to a week and never a new week's
  completion. Making a sensitive note shared needs `confirmAudienceChange`;
  only the current version becomes shared, and prior revisions stay where they
  always were.
- `voidUpdate` is the only moderation path and is operators only. The entry,
  its body and every revision stay; the audit event carries the ids and the
  reason and never the body. There is no delete anywhere in the module, which
  is how "prevent production hard deletion of revisions through ordinary app
  permissions" is met.
- `readAuthorizedUpdates` applies the audience **in SQL**: a member who is not
  an entry's author never receives a sensitive body, its existence, or a
  voided entry at all, so there is nothing to hide in the browser. A denial is
  an empty page, so an unrelated Captain cannot tell a project with no updates
  from one they may not read. Keyset paged on `(submitted_at, id)`; no
  revision is ever joined.
- `readRevisionHistory` is operators only, the author included, and returns an
  empty list rather than a refusal that would confirm the entry exists.
- `reportingStatus` answers a whole edition in **seven queries whatever the
  project count**. A stored outcome is authoritative wherever one exists,
  correction included; for a period that has ended but has not been closed
  yet, the same rule `closePeriod` would apply is computed live, so a
  dashboard is honest about a missed week before the closure job has run. It
  carries `projectName` and `imported` and no entry body at all.
- `closePeriod` is idempotent: every insert is `ON CONFLICT DO NOTHING` and an
  already-closed period returns its stored outcomes unchanged, so a job that
  runs twice cannot rewrite history. It records the Captain at close and
  audits as a `system` actor when a job calls it.
- `correctOutcome` is operators only, requires a reason, refuses a correction
  that changes nothing, and writes `reporting.outcome_corrected`.

**A successful import enters reporting (`lib/hq/builder-store.ts`).**
`importTeam` calls `enableReporting` inside its own transaction, beside the
`project.imported` audit event and for the same reason: a committed team is
never outside reporting, and a rolled-back import leaves no eligibility row.

**Both deletions extended (`lib/hq/record-deletion.ts`).**
`teamRemovalImpact` and `teamRemovalImpacts` now count the eligibility row,
the entries, **every saved version of them** and the recorded weeks; the audit
event records the same counts, and Admin's Delete team confirmation names
them. All four cascade, which is right for all four — a team's updates, its
history, whether it was in reporting and what each week recorded are
statements about that team. `hq_reporting_periods` is deliberately untouched:
the periods belong to the edition, and the other teams still report against
them. **`deletePersonRecord` needed no row change**, which is a decision and
not an omission: nothing in the reporting tables points at `hq_people` or
`hq_crm_persons`, and deleting a People card never deletes the
`hq_builder_profiles` account an entry names. A person's updates therefore
survive their card, which is correct — the card is an edition's CRM entry, the
updates are a team's record of its own weeks. A test pins it.

**The Captain reduced-card gap, decided rather than rediscovered.** Reporting
is keyed on `hq_projects`, never on `hq_project_onboarding`. A project an
admin created directly in the CRM therefore gets the same eligibility row, the
same periods, the same status and its own name, and `ReportingEligibility` and
`ProjectReportingStatus` both carry `imported` so a caller that also wants
team detail knows in advance whether there is any. What such a project lacks
is roster and Colosseum detail, which reporting never needed, so a **reporting
surface has nothing reduced about it**; `/hq/captain`'s existing reduced card
stays reduced only in the team fields it never had. A test asserts both
shapes side by side.

**Four audit kinds added** to the one vocabulary in `lib/hq/audit-sql.ts`:
`reporting.eligibility_changed`, `reporting.entry_voided`,
`reporting.outcome_corrected` and `reporting.period_closed`. Reporting content
itself is never audited; these record only the decisions about it.

### Which migrations apply

All in `scripts/hq/builder-schema.sql`, applied by `hq:migrate` in the usual
order, all idempotent single statements through the splitter:

- Six `CREATE TABLE IF NOT EXISTS` and five `CREATE INDEX IF NOT EXISTS`. Every
  CHECK constraint is written **inside** its column or as a named table
  constraint in the `CREATE TABLE`, never as a separate `DROP CONSTRAINT` /
  `ADD CONSTRAINT` pair: migration convention 8's reasoning about
  drop-then-create pairs applies to constraints exactly as to indexes, and a
  constraint created with its table is skipped with the table on every later
  run.
- No backfill: there is nothing to backfill. A period row is created by
  `ensureReportingPeriods` from the edition's own dates, and eligibility by an
  import or an admin, both after the migration.
- `scripts/hq/reset-statements.ts`: `hq_reporting_config` in `KEEP_TABLES`
  (Admin configuration, like `hq_settings` and `hq_hackathon_onboarding`); the
  other five in `CLEAR_TABLES`, children first. The periods go too, even
  though nobody typed them: they are generated deterministically from the
  edition's dates and `hq_reporting_config`, which both survive, so the
  schedule comes back identical on the next `ensureReportingPeriods` — and
  keeping them while their entries and outcomes were cleared would leave
  periods marked closed with nothing recorded against them.

### Checks passed

Named tests, one per acceptance bullet.

| Acceptance bullet | Test |
|---|---|
| Team, Captain, admin and sensitive-note entries each correctly complete a week | `tests/hq/reporting.test.ts`: "an update from %s completes the week" (six cases: team lead, joined teammate, assigned Captain, Captain privately, admin, admin privately), "completes the week from a sensitive note without the team learning anything about it" |
| Empty entries, edits to older weeks and failed saves do not complete the current week | `tests/hq/reporting.test.ts`: "refuses an empty body and one over the maximum, and saves neither", "does not complete the week from a save that failed", "never completes the current week by editing an older one", "does not let a late entry complete a week that has already passed, closed or not" |
| Multiple entries, conflicting edits and bot/web retries preserve correct authorship and history | `tests/hq/reporting.test.ts`: "does not let a second entry create a second completion", "keeps authorship and history correct when both surfaces edit the same entry", "refuses an edit whose expected version is stale, and hands back the current entry so the unsaved text survives", "records which surface an entry came from, and applies the same rules to both", "does not create two entries when the same save is retried after a refusal", "lets an admin correct any entry while the original author is preserved" |
| Late entries preserve the original missed outcome. Admin corrections retain an audit reason | `tests/hq/reporting.test.ts`: "keeps the missed outcome after a late entry is added, and marks the entry late", "is idempotent, and a second close never rewrites what the first recorded", "is admin only and requires a reason", "writes the correction beside the original outcome and audits it" |
| Team views reveal no sensitive body or revision, including after visibility changes | `tests/hq/reporting.test.ts`: "shows the team its own updates and the shared Captain note, and nothing of the sensitive one", "shows another Captain nothing at all, not even that the project exists", "keeps the sensitive note out of the team's view after it is made shared, and only from that version on", "is admin only, whoever wrote the entry", "hides a voided entry from the team and shows it to an admin, marked", "carries no entry body and no revision in a dashboard response" |
| Timezone, boundary, final-Monday and late-enrollment tests match the period table | `tests/hq/reporting-periods.test.ts`: "produces exactly the four periods the plan's table names", "stores UTC instants with an exclusive end, so no fifth period begins on 12 October", "leaves no gap and no overlap between consecutive periods", "keeps local midnight boundaries across an autumn clock change", "resolves a summer-time / winter-time local midnight", "truncates the weekly period that a mid-week final start interrupts", "treats the end as exclusive, so a boundary instant belongs to the next period"; `tests/hq/reporting.test.ts`: "fabricates no missed week before a project entered reporting", "leaves out a project that had not entered reporting by the period's end" |

The performance rules have their own tests: "answers a whole edition's
dashboard in a fixed number of queries, whatever the project count" (seven,
measured at twelve projects and at one) and "carries no entry body and no
revision in a dashboard response". `tests/hq/migration-order.test.ts`
("phase 5: the reporting tables") applies the whole migration twice on a
fresh database and asserts each table, the body and visibility constraints,
the two uniqueness rules, the cascade from `hq_projects` and that an entry
keeps its author when the authoring account is deleted.
`tests/hq/reset.test.ts` seeds a full reporting chain so neither the keep nor
the clear side is vacuous. `tests/hq/authz.test.ts` replaced its stub
assertion with "loadEntry reads a reporting entry with its project's edition,
and treats a malformed id as missing without a query", covering the operator
namespacing. `tests/hq/builder-onboarding.test.ts` gained "puts the imported
team straight into weekly reporting, with the edition's schedule" and "leaves
no eligibility row behind when the import itself rolls back".

Verification run at commit `bd94560`, re-run at the docs commit: `npm test`
1,091 tests in 48 files passing (phase 3 closed at 970); `npx tsc --noEmit` clean; `npm run lint` 0
errors and 18 warnings, all pre-existing and all in
`public/deck/deck-stage.js`, unchanged from the phase 0 baseline; `npm run
build` passes.

### Blocked or deferred

- **Nothing in this phase is browser-verified**, because nothing in it renders:
  phase 5 is the model, phase 6 the screens. Every check is at the service,
  SQL or schema level.
- **No Server Action and no page was added**, deliberately, per the standing
  "no stub source files" rule. Phase 6 adds the team, Captain and admin
  surfaces and the actions behind them; phase 7 the bot handlers; phase 8 the
  reminder and closure jobs. `previewReportingPeriods`,
  `ensureReportingPeriods`, `pauseReporting`, `closePeriod` and
  `correctOutcome` therefore have no production caller yet — they are the
  service entry points those phases call, named in the contract, not stubs.
- **"Concurrent" is proven by outcome arithmetic and a real row lock, not by
  true interleaving.** PGlite serializes whole transactions on one connection,
  the same limit phase 4 recorded. "Keeps authorship and history correct when
  both surfaces edit the same entry" proves exactly one edit wins, the loser is
  told and keeps its text, and the revision chain has no gap; it does not prove
  the behaviour of two genuinely simultaneous connections, which the row lock
  and the `version` predicate in the `UPDATE` are what actually enforce.
- **A spring-forward local time has no instant.** `zonedDateTimeToUtc` lands on
  the moment the clock jumped to rather than throwing. No campaign date in the
  plan falls in such a gap, and a period boundary at local midnight cannot,
  since no zone skips midnight; it is recorded because a future edition with a
  different timezone or nudge time could.
- **The team-level preferred contact** is still not built (phase 3's carried
  deferral). `MemberTeamView.captain.contact` is still always null, and phase
  6's team dashboard remains its natural home.
- The **Wednesday nudge instant** is computed and stored per period
  (`nudge_at`) but nothing sends anything: delivery is phase 8's, and the
  setting lives in `hq_reporting_config` so that phase does not have to edit
  bot code to change it.

### Changed interfaces

For phase 6 and later. Everything below is reachable from
`lib/hq/reporting.ts`; `lib/hq/reporting-enrolment.ts` and
`lib/hq/reporting-periods.ts` are implementation detail a caller need not
import directly.

- Schedule and periods: `readReportingSchedule(db, hackathonId)`,
  `listReportingPeriods(db, hackathonId)`,
  `currentReportingPeriod(db, hackathonId, atMs?)`,
  `ensureReportingPeriods(db, hackathonId)`,
  `previewReportingPeriods(db, hackathonId)`; types `ReportingPeriod`,
  `ReportingPeriodPlan`, `ReportingPeriodConflict`, `ReportingSchedule`,
  `GeneratedPeriod`, `ReportingPeriodMode`.
- Eligibility: `reportingEligibility(db, projectId)`,
  `listReportingEligibility(db, hackathonId)`,
  `enableReporting(db, { projectId, hackathonId, operatorId? })`,
  `pauseReporting(db, { projectId, hackathonId, paused, operatorId, reason? })`;
  types `ReportingEligibility`, `ReportingEligibilityResult`.
- Entries: `createUpdate(actor, input, db?)`, `editUpdate(actor, input, db?)`,
  `voidUpdate(actor, input, db?)`, `readAuthorizedUpdates(actor, input, db?)`,
  `readRevisionHistory(actor, input, db?)`, `MAX_BODY_LENGTH`; types
  `ReportingEntryView`, `ReportingEntryPage`, `ReportingRevision`,
  `CreateUpdateInput`/`CreateUpdateResult`/`CreateUpdateRefusal`,
  `EditUpdateInput`/`EditUpdateResult`/`EditUpdateRefusal`, `VoidUpdateResult`.
- Status and outcomes: `reportingStatus(db, input)`,
  `closePeriod(db, { periodId, actor, atMs? })`,
  `listPeriodOutcomes(db, periodId)`, `correctOutcome(actor, input, db?)`;
  types `ProjectReportingStatus`, `PeriodStatus`, `PeriodOutcome`,
  `SubmissionStatus`, `ClosePeriodResult`, `CorrectOutcomeResult`.
- `lib/hq/authz-sql.ts#loadEntry` reads real rows. Its type and the decisions
  over it are unchanged; an operator author reads back as `operator:<id>`.
- `lib/hq/record-deletion.ts#TeamRemovalImpact` gained `reportingEnrolled`,
  `reportingEntries`, `reportingRevisions` and `reportingOutcomes`. Any new
  reader of that type must handle them; `components/hq/builder-admin.tsx`
  already names them in the Delete team confirmation.
- `lib/hq/audit-sql.ts#AUDIT_EVENT_KINDS` gained the four `reporting.*` kinds.
  `tests/hq/capabilities.test.ts` pins the exact list, so a later phase adding
  a kind updates it there too.

### External configuration still required

None new. Phase 5 needs nothing from Colosseum and no environment variable of
its own. The one operator input it does depend on is the edition's own
`start_date` and `end_date` in Admin, which are already set, plus — optionally
— the edition's `hq_reporting_config` row. Without that row an edition still
has a schedule: a purely weekly one over its own dates, with a Wednesday 12:00
nudge. The agreed 2026 campaign needs `final_period_start_date = 2026-10-05`
for the 5 to 12 October window to be one submission-focus period rather than a
week plus a stray day, and `official_submission_deadline` only if Colosseum's
own cutoff turns out to be earlier than 13 October 00:00 Amsterdam. Both are
recorded in `docs/hq/manual-setup.md`.
