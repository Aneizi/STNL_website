# HQ module contracts

The agreed module boundaries, entry points and conventions for the Captains and
Colosseum plan (`docs/plans/2026-09-13-hq-captains-and-colosseum.md`). This file
is a reference, not a plan. It says where a thing belongs, what it is called and
which phase creates it, so that later phases do not re-invent a boundary or
guess a path.

Two standing rules:

1. **No stub source files.** Phases 3 to 10 are named here and nowhere else. A
   stub route handler would be a live endpoint, and a stub module is work with no
   user. The typed hooks that authorization needs for phase 4 and phase 5 records
   live inside `lib/hq/authz.ts`, which phase 1 creates, not in placeholder
   files of their own.
2. **No real secrets and no real external ids in code.** Environment variable
   names live in `docs/hq/manual-setup.md`. The Colosseum external edition
   mapping is operator data in `hq_hackathon_onboarding`, never a constant and
   never seeded.

## Conventions

- Server modules start with `import "server-only"`.
- Pure SQL builders that tests import stay free of `server-only`, following the
  `lib/hq/luma-sync-sql.ts` pattern.
- Operator side data goes through `getSql()` from `lib/hq/db.ts` with
  `sql.transaction([...])` statement batches.
- Builder side data goes through `BuilderDatabase.transaction(work)` callbacks
  from `lib/hq/builder-store.ts`. New phase 1 services use the callback pool,
  because identity and capability writes need read then write atomicity in one
  transaction, which a statement batch cannot express.
- Atomicity is proved by tests, not by prose. Each of T1.1 and T1.2 carries a
  test where a failing second statement rolls back the first.
- Actor ids come only from `requireUser()`, `currentMember()` or a verified job
  token. Never from a form field, a query parameter or a cookie.
- The `hq_hackathon` cookie is a convenience, never authorization. Captain
  scoping is checked server side, per request, against current grants and
  assignments.
- A member route must be added in two places, `proxy.ts` and `safeMemberNext`,
  until task T2.4 unifies them behind one exported list.

## Actor representation, phase 1

`lib/hq/actor.ts`, server only:

```ts
export type Actor =
  | { kind: "operator"; id: string; displayName: string }
  | { kind: "member";   id: string; name: string; email: string | null;
      capabilities: ReadonlySet<Capability>; telegram: { userId: string } | null }
  | { kind: "job";      audience: string };

export async function currentActor(): Promise<Actor | null>;
export async function requireMemberActor(next?: string): Promise<Extract<Actor, { kind: "member" }>>;
export async function requireOperatorActor(): Promise<Extract<Actor, { kind: "operator" }>>;
```

The operator shape comes from `requireUser()`, the member shape from
`currentMember()`, and the job shape from a verified OIDC job token in phase 8.
`currentActor()` resolves operator first, then member.

`telegram.userId` is a **string** at every JSON boundary. Telegram ids exceed
the safe integer range in some runtimes, and a number would be a silent
corruption.

A public role never creates operator access. `requireOperator()` in the
authorization module is a thin wrapper over `requireUser()`, and there is no path
from a public account to an `hq_users` row.

## Module to file map

Phase column is the phase that creates the module. "Named only" means no file
exists yet and none should be created before that phase.

| Module | Owns | Repo files | Typed entry points | Phase |
|---|---|---|---|---|
| Identity | verified login identities, sessions, linking, optional contact email | `lib/hq/member-auth.ts`, new `lib/hq/telegram-provider.ts`, new `lib/hq/telegram-identity-plugin.ts`, new `lib/hq/identity.ts` | `isPlaceholderEmail(email)`, `getLoginMethods(userId)`, `hasTelegramIdentity(userId)`, `getTelegramIdentity(userId)`, `verifiedLoginEmail(user)`, `isVerifiedAccount(user)` (the one definition of "verified account"; every session reader imports it) | 0 spike, then 1 and 2 |
| Authorization | operator checks, capabilities, membership, assignment, note audience | `lib/hq/authz.ts` with pure loaders in `lib/hq/authz-sql.ts`; member-facing team reads over the decision in `lib/hq/member-teams.ts`; operator actions resolve record ids through `inHackathon` in `lib/hq/actions/util.ts` | `getActorCapabilities(actor)`, `authorizeProjectAction(actor, { projectId, hackathonId, action }, loaders?)` returning `Authorization`, `requireOperator()`, `isTeamMember(actor, projectId)`, `isAssignedCaptain(actor, projectId)`, `entryAudience(entry, actor)`, `canEditEntry(actor, entry)`, `canReadRevisionHistory(actor)`, `assertHackathonMatches(record, hackathonId)`; loaders are injectable per call and never cached across requests. The typed hooks `loadCurrentAssignment(db, projectId)` (phase 4) and `loadEntry(db, entryId)` (phase 5) live in `authz-sql.ts` and return null until their tables exist; the decisions over them are tested with injected fixtures. `authorizedTeam(actor, { projectId, hackathonId?, action })` and `memberTeamView(actor, projectId)` return null for every denial; `inHackathon(record, hackathonId)` returns null for a missing record and for one from another edition alike | 1 |
| Capability grants | grant and revoke, one effective grant per capability, audit trail | `lib/hq/capabilities.ts`, `lib/hq/actions/capabilities.ts` (operator gated) | `Capability = "captain"`, `grantCapability(db, { actorOperatorId, userId, capability, reason })` and `revokeCapability(db, ...)` (idempotent, the only writers of `hq_account_capabilities`, audit event in the same transaction), `listActiveCapabilities(userId)`, `listActiveCapabilitiesForUsers(userIds)`, `listCapabilityGrants({ capability, activeOnly? })`, `personTags(roleLabel, capabilities)`; actions `grantCaptainCapability(userId, reason)`, `revokeCaptainCapability(userId, reason)` | 1 |
| CRM person identity | stable person id, account link, edition People references, explicit correction | `lib/hq/crm-identity.ts`, `lib/hq/queries.ts`, `lib/hq/actions/people.ts` | `normalizeColosseumUsername(raw)`, `ensurePersonForAccount(db, { userId, displayName })`, `ensurePersonForRosterMember(db, { colosseumUsername, displayName })`, `linkPersonToAccount(db, { personId, userId })` (each writes through the query handle it is given, so it joins the caller's `BuilderDatabase.transaction`), `correctPersonMatch(db, { personId, toUserId, reason, actor })` (detach, link, or merge into the account's own person; never by display name) and the operator action `correctPersonMatch({ personId, toUserId, reason })` | 1, used from 3 |
| Audit | append only metadata events | `lib/hq/audit.ts`, `lib/hq/audit-sql.ts` | `recordAuditEvent(db, { kind, actor, subjectUserId?, hackathonId?, projectId?, metadata? })`, `listAuditEvents(filter, { limit, cursor })`; nothing else | 1 |
| Actor aware response types | the smallest DTO per audience | new `lib/hq/view-models.ts` | `MemberTeamView`, `CaptainAssignmentView`, `PublicPersonView` | 1 |
| Shell and navigation | capability driven member menu | new `app/hq/(member)/layout.tsx`, new `components/hq/builder-nav.tsx`, `components/hq/builder-shell.tsx`, new `lib/hq/member-routes.ts` | `MEMBER_PUBLIC_PATHS`, `getMemberNav(actor)` | 2 |
| Colosseum integration | validated snapshots, normalized fields, source status | `lib/colosseum-api.ts` extended, `lib/hq/colosseum-snapshot.ts` named only | `claimProject`, `refreshProject`, `listCountryProjects` | 3 |
| Captain service | invitations, assignment changes | `lib/hq/captains.ts`, `lib/hq/actions/captains.ts`, named only | `acceptCaptainInvitation`, `assignCaptain`, `unassignCaptain`, `leaderboard` | 4 |
| Reporting service | periods, entries, revisions, completion | `lib/hq/reporting.ts`, named only | `createUpdate`, `editUpdate`, `readAuthorizedUpdates`, `reportingStatus`, `closePeriod` | 5 |
| Telegram adapter | authenticated chat commands, drafts, delivery | `lib/hq/telegram-bot.ts`, `app/api/telegram/webhook/route.ts`, named only | decided in phase 7 | 7 |
| Job runner | reminders, closures, bounded sync | `lib/hq/jobs.ts` named only, `lib/hq/github-actions-auth.ts` parameterised by audience and workflow | `prepareReminder`, with a separate OIDC audience and no shared privileges | 8 |
| Discovery snapshot and readiness | Dutch projects missing from HQ, final submission readiness | named only | decided in phases 9 and 10 | 9, 10 |

Audit event kinds, so that later phases extend one vocabulary instead of
inventing their own: `capability.granted`, `capability.revoked`,
`identity.linked`, `identity.unlinked`, `identity.email_changed`,
`person.linked`, `person.match_corrected`, and reserved for phase 4
`captain.assigned` and `captain.unassigned`. They are the
`AUDIT_EVENT_KINDS` union in `lib/hq/audit-sql.ts`. Note bodies never go into
audit. The audit module exposes no update and no delete, and
`tests/hq/capabilities.test.ts` asserts that.

The builder-side pool lives in `lib/hq/builder-db.ts` (`builderDatabase()`,
`BuilderQuery`, `BuilderDatabase`, `atomically()`), re-exported from
`lib/hq/builder-store.ts`. Modules the store imports (identity, audit,
capabilities) take the pool from `builder-db.ts` so there is no import cycle.

A People card's tags are presentation: `PersonTag = { kind: "role" |
"capability"; label; protected }`. The role tag is the editable role. The
capability tag mirrors an active grant and nothing reads a tag back to decide
access; access is checked against `hq_account_capabilities` per request.

Operator only fields stay in `lib/hq/types.ts`. The view models exist so that a
member response cannot accidentally carry an operator field.

## Phase checklist

### Phase 0

- Baseline recorded. Done, see `docs/hq/implementation-log.md`.
- Telegram strategy designed and source verified, **not proven**. Task T0.1, the
  spike, must pass before phase 1 starts and before any Telegram UI.
- Admin login regression anchors named. The gap over `lib/hq/actions/auth.ts` is
  task T0.3.
- Colosseum capabilities and limits recorded. Done, see below and
  `tests/hq/fixtures/colosseum/README.md`.
- Module contracts named. This file.
- Manual setup list started. `docs/hq/manual-setup.md`.
- Fictional fixtures and the asset path record. Done, task T0.2.

### Phase 1 gate

- Additive migrations apply twice, on a fresh and on a populated database,
  through the statement splitter.
- A member cannot read operator data through a URL, a body field, a project id or
  the hackathon cookie.
- A `captain` grant on its own opens no project.
- Editing a People role or tag cannot grant `captain`.
- A revocation is visible on the next request. Bot requests are deferred to
  phase 7.
- Existing `hq_users` ids, credentials and People links survive the migration.
- Grant plus audit, and link plus identity, are written atomically.

### Phase 2 gate

- Telegram only, email only and linked accounts all complete sign-in and land on
  the safe `next` target.
- Linking preserves the account id, the teams and the grants.
- Admin login is unchanged.
- A failed or expired login grants nothing. Invitation use is deferred to
  phase 4.
- Consent to be messaged by the bot is collected separately from sign-in, and the
  wording is accurate.
- Google and GitHub are gone.
- An unconfigured provider shows an honest unavailable state, and a Telegram
  outage does not affect email login.
- Both member route allowlists come from one source.
- The rate limit and cookie review is recorded with outcomes, task T2.5.

## Migration conventions

The runner, `scripts/hq/migrate.ts`, applies `schema.sql`, then `applyUpgrades()`,
then `member-auth-schema.sql`, then `builder-schema.sql`. One statement per
call, no transaction, no ledger. Idempotence is the only replay strategy.
`upgrades.ts` runs **before** the two additive files, so an upgrade step cannot
assume that the builder or auth tables exist.

The splitter is `text.split(/;\s*(?:\n|$)/)`, trimmed and filtered. It cannot
parse `DO $$ ... END $$` blocks, function or trigger bodies, a `;` at end of line
inside a string literal or a `--` comment, or conditional DDL. Two statements on
one line survive the splitter but break the one statement per call rule in
production. Tests that use `pg.exec()` bypass the splitter and would not catch
any of this, so migration tests apply SQL **through the splitter**.

Where DDL goes:

1. **New tables:** `CREATE TABLE IF NOT EXISTS` plus
   `CREATE INDEX IF NOT EXISTS`, one statement each. Auth side tables that
   reference `hq_auth_user`, such as `hq_auth_telegram_identity`, go in
   `scripts/hq/member-auth-schema.sql`. Builder and CRM side tables that
   reference `hq_builder_profiles`, such as `hq_account_capabilities`,
   `hq_audit_events`, `hq_crm_persons` and `hq_telegram_bot_consent`, go in
   `scripts/hq/builder-schema.sql`.
2. **Changes to core tables** (anything in `schema.sql`): guarded steps in
   `scripts/hq/upgrades.ts`, appended after `applyHackathonScoping`. Use
   `ADD COLUMN IF NOT EXISTS`, `to_regclass('name')` before a unique or partial
   index, a `pg_constraint` lookup before a constraint, and `columnInfo()` for
   nullability. Identifiers are interpolated constants, never input.
   **Exception (DDL-PLACEMENT ruling):** a core-table column whose foreign key
   targets a builder-side table lives in `builder-schema.sql`, after the table
   it references, because `upgrades.ts` runs before that table exists.
   `hq_people.person_id` and `hq_project_members.person_id` are the examples.
   Seeded-row edits such as the "Partner captain" rename stay in
   `upgrades.ts`, guarded by `to_regclass` and a `NOT EXISTS` on the new value.
3. **Changes to existing builder or auth tables:**
   `ADD COLUMN IF NOT EXISTS` and `ALTER COLUMN ... DROP NOT NULL` are
   idempotent single statements and may live directly in the additive `.sql`
   file. Update the `CREATE TABLE` for fresh databases **and** add the `ALTER`
   for populated ones. Do not put these in `upgrades.ts`: it runs first, so an
   unguarded `ALTER` there fails on a fresh database. Anything in `upgrades.ts`
   that touches a builder or auth table must check `to_regclass` first and
   tolerate the table not existing yet.
4. **New `hackathon_id` indexes** on pre-existing tables stay in `upgrades.ts`,
   not in `schema.sql`.
5. **Classify every new `hq_%` table** in `scripts/hq/reset-statements.ts`, in
   `CLEAR_TABLES` or `KEEP_TABLES`. `tests/hq/migration-order.test.ts` applies
   all three SQL files through the splitter, in migrate order, and asserts that
   every `hq_%` table is classified. The one table in neither list is
   `hq_luma_sync`: `RESET_STATEMENTS` rewinds its single row with a dedicated
   `UPDATE` instead of clearing or keeping it, and the test names it as such.
6. **Test the migration** twice on a fresh database and once over
   `tests/hq/fixtures/schema-pre-hackathon.sql` with a populated fixture. Assert
   with `to_regclass` and `information_schema.columns`.
7. **Seeded rows** such as roles and statuses use
   `INSERT ... ON CONFLICT (key) DO NOTHING`. Never seed the Colosseum external
   mapping.

## Colosseum integration, what the API can and cannot do

Observed on 2026-09-13 against the public API. Structural fixtures and the full
provenance note live in `tests/hq/fixtures/colosseum/`.

Capabilities:

- `GET /api/projects/directories` lists editions with `id`, `name`, `slug`,
  `phase`, `landingPageUrl` and `emoji`. No dates.
- `GET /api/projects` lists submitted projects of editions whose directory is
  enabled. Array parameters must use the bracket form, `hackathonIds[]=...`, and
  `hackathonIds` is required. Sorting is `NAME` or `RANDOM` only. The envelope
  carries a `hackathons` block that includes `projectSubmissionEndDate`, which is
  the deadline to compare a submission time against.
- `GET /api/project?slug=...&type=HACKATHON` returns `projectType`, `project`
  and `projectCompletion`. The `project` object has the same key set as a listing
  row.
- `GET /api/project/comments?projectId=...&offset=...` pages comments, and the
  comment body is a rich text tree.

Limitations, all of which shape phase 3 and later:

- **The current edition is invisible.** External id 6 is the finished Frontier
  edition. An edition with external id 7 exists but its project directory is
  disabled, so its name, slug and dates are unobtainable. A "Dutch
  registrations" view must say "edition not available", never 0.
- **There is no registration feed.** Only submitted projects of enabled editions
  are listed, and no parameter to include drafts is documented. Registered but
  unsubmitted teams cannot be discovered.
- **Ownership proof before submission is not possible** through the API, because
  the comment challenge needs the detail endpoint to return the project. The
  fallback is the existing manual review path.
- **`submittedAt` is the submission signal.** It was non null on every observed
  row. Its value for a draft is unverified, assumed `null`.
- **`projectCompletion` is a readiness diagnostic**, returned by the detail
  endpoint only. It must never drive a "Submitted" badge, and the element type of
  `fieldErrors` is unverified.
- **No sort by submission date.** A "new submissions since X" poll has to page
  the country subset and diff by id and `submittedAt`.
- **Error bodies are discarded today.** Every non 2xx other than 404 and 429
  collapses to `UNAVAILABLE`, so "directory disabled" and "unknown edition" are
  indistinguishable until an adapter reads `code` and `message`.
- **Rate limits are unknown.** No 429 was observed. A listing refresh must be
  server side, bounded, cached, and must show the last successful refresh time.
- **Images and avatars are on a third party host**,
  `static.narrative-violation.com`. If images are ever proxied or run through
  `next/image`, that host has to be allow-listed in `remotePatterns`.
- **The client's zod objects are not strict.** Unknown fields survive only
  inside the retained `raw` snapshot, and a renamed `teamMembers` would surface
  as a generic `INVALID_RESPONSE` rather than a precise error.

Client gaps to close in phase 3: there is no listing client, no bracket array
query builder, no `hackathons` envelope parsing, and `submittedAt`,
`projectCompletion`, `category`, `twitterHandle`, `comments` and
`isUniversityProject` are not in `projectSchema` or `ImportedProject`. There is
also no storage for a snapshot's submission status or last refresh time.

## Companion asset

The approved project fallback image:

- **Source:** `docs/plans/assets/hq-project-fallback.png`, untracked in this
  checkout. A copy is kept at
  `.superpowers/sdd/2026-09-13-hq-captains-and-colosseum/hq-project-fallback.png`.
- **Target, phase 3:** `public/images/hq/project-fallback.png`.

The plan's original path, `assets/hq-project-fallback.png`, does not exist at the
repository root. Phase 3 copies the source above and references the target path.
