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

Not started.
