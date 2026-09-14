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
- `enroll()` is unchanged (ruling Q5). Its `INSERT ... ON CONFLICT` still
  assumes no other card in the edition carries the account's person. That
  state cannot arise today (only accounts get People cards with a person),
  but a phase 3 roster import that creates People cards for roster persons
  would make it reachable, and `enroll()` would then need the same
  `NOT EXISTS` guard the backfill and the link stamp have.
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
- A `customSession` transform was not added: no client code reads
  `session.user` (grep over `app`, `components` and the auth client), and the
  placeholder guard is the markup test plus the server-only readers.
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
