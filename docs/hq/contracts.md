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
- A member route is added in exactly one place, `MEMBER_PUBLIC_PATHS` in
  `lib/hq/member-routes.ts`. `proxy.ts` asks `isMemberPath()` and
  `lib/hq/member-auth-config.ts` re-exports `safeMemberNext`, so neither file
  keeps a route literal of its own. Task T2.4 unified the two lists;
  `tests/hq/member-routes.test.ts` asserts that neither file drifts back.

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
| Identity | verified login identities, sessions, linking, optional contact email | `lib/hq/member-auth.ts`, new `lib/hq/telegram-provider.ts`, new `lib/hq/telegram-identity-plugin.ts`, new `lib/hq/identity.ts`, `lib/hq/actions/telegram.ts` (member gated); task T4.2 added `lib/hq/placeholder-email.ts` (`PLACEHOLDER_DOMAIN` and `isPlaceholderEmail` are defined here — the one leaf module with no `server-only` and no Better Auth import — and re-exported, unchanged, from `telegram-provider.ts` and `identity.ts` for every existing caller) | `isPlaceholderEmail(email)`, `getLoginMethods(userId)`, `hasTelegramIdentity(userId)`, `getTelegramIdentity(userId)`, `verifiedLoginEmail(user)`, `isVerifiedAccount(user)` (the one definition of "verified account"; every session reader imports it); phase 2: `isRecentSession(session)` and `telegramIsLastLoginMethod(user)` (the one recency rule and the one last-login-method rule, enforced by the plugin's before hooks and read by the confirmation actions), `recordTelegramIntent(store, userId, intent)`, `currentMemberSession()` (its `user.email` is null for a Telegram-only account: a `customSession` transform replaces the internal placeholder on `/get-session`, and so on every reader of a session, `StoredAccount.email` being `string | null` for that reason), `redirectToMemberSignIn(next)`, and the actions `confirmLinkTelegram()`, `confirmUnlinkTelegram()`; task T2.3: `confirmEmailChange(newEmail)` (the confirmation before the emailOTP change-email endpoints; the intent is bound to the address, and an account that already has a verified login email is refused with `EMAIL_ALREADY_SET`, so the endpoints only ever add a first address), `normalizeEmailAddress(value)`, the `user.update.after` hook in `member-auth.ts` (notifies the previous verified real address and records `identity.email_changed`), and in `lib/hq/telegram-consent.ts` `getBotConsent(userId)`, `setBotConsent(actor, enabled)`, `revokeBotConsent(userId, db)` with the action `setBotMessaging(enabled)` | 0 spike, then 1 and 2 |
| Authorization | operator checks, capabilities, membership, assignment, note audience | `lib/hq/authz.ts` with pure loaders in `lib/hq/authz-sql.ts`; member-facing team reads over the decision in `lib/hq/member-teams.ts`; operator actions resolve record ids through `inHackathon` in `lib/hq/actions/util.ts` | `getActorCapabilities(actor)`, `authorizeProjectAction(actor, { projectId, hackathonId, action }, loaders?)` returning `Authorization`, `requireOperator()`, `isTeamMember(actor, projectId)`, `isAssignedCaptain(actor, projectId)`, `entryAudience(entry, actor)`, `canEditEntry(actor, entry)`, `canReadRevisionHistory(actor)`, `assertHackathonMatches(record, hackathonId)`; loaders are injectable per call and never cached across requests. The typed hooks `loadCurrentAssignment(db, projectId)` (phase 4, reads real rows from `hq_captain_assignments` since task T4.1) and `loadEntry(db, entryId)` (phase 5, still a stub returning null until that table exists) live in `authz-sql.ts`; the decisions over them are tested with injected fixtures, independent of whether the loader body is real. `assertHackathonMatches` is defined in `authz-sql.ts` and re-exported from `authz.ts`: it reads no session, and `actions/util.ts` imports it from the leaf so the operator action modules do not reach the member auth graph (`tests/hq/operator-imports.test.ts`). `authorizedTeam(actor, { projectId, hackathonId?, action })` and `memberTeamView(actor, projectId)` return null for every denial; `inHackathon(record, hackathonId)` returns null for a missing record and for one from another edition alike | 1 |
| Capability grants | grant and revoke, one effective grant per capability, audit trail | `lib/hq/capabilities.ts`, `lib/hq/actions/capabilities.ts` (operator gated) | `Capability = "captain"`, `grantCapability(db, { actor, byOperatorId, userId, capability, reason })` and `revokeCapability(db, ...)` (idempotent, the only writers of `hq_account_capabilities`, audit event in the same transaction). `actor` is the `AuditActor` the event records, `byOperatorId` the `hq_users` id the row is attributed to (`granted_by_user_id` / `revoked_by_user_id`) or null: a member redeeming a Captain invitation in phase 4 is a member actor with the inviting operator as `byOperatorId`. Grants are account-global, never scoped to an edition. Also `listActiveCapabilities(userId)`, `listActiveCapabilitiesForUsers(userIds)`, `listCapabilityGrants({ capability, activeOnly? })`, `personTags(roleLabel, capabilities)`; actions `grantCaptainCapability(userId, reason)`, `revokeCaptainCapability(userId, reason)` | 1 |
| CRM person identity | stable person id, account link, edition People references, explicit correction | `lib/hq/crm-identity.ts`, `lib/hq/queries.ts`, `lib/hq/actions/people.ts` | `normalizeColosseumUsername(raw)`, `ensurePersonForAccount(db, { userId, displayName })`, `ensurePersonForRosterMember(db, { colosseumUsername, displayName })`, `linkPersonToAccount(db, { personId, userId })` (each writes through the query handle it is given, so it joins the caller's `BuilderDatabase.transaction`), `correctPersonMatch(db, { personId, toUserId, reason, actor })` (detach, link, or merge into the account's own person; never by display name) and the operator action `correctPersonMatch({ personId, toUserId, reason })` | 1, used from 3 |
| Audit | append only metadata events | `lib/hq/audit.ts`, `lib/hq/audit-sql.ts` | `recordAuditEvent(db, { kind, actor, subjectUserId?, hackathonId?, projectId?, metadata? })`, `listAuditEvents(filter, { limit, cursor })`; nothing else | 1 |
| Actor aware response types | the smallest DTO per audience | new `lib/hq/view-models.ts` | `MemberTeamView`, `CaptainAssignmentView`, `PublicPersonView`, `CaptainLeaderboardView` (`{ rank, displayName, assignedCount, isYou }`; `assignedCount` and `isYou` filled by task T4.5, `toCaptainLeaderboardView`) | 1, filled by 4 |
| Shell and navigation | capability driven member menu, one member route list | new `lib/hq/member-routes.ts`, new `lib/hq/member-nav.ts` (both pure and client-safe), new `components/hq/builder-nav.tsx`, `components/hq/builder-shell.tsx`, new `app/hq/(member)/layout.tsx` (a provider, **not** the auth boundary) | `MEMBER_PUBLIC_PATHS`, `isMemberPath(pathname)`, `safeMemberNext(value)` in `member-routes.ts`; `NavItem`, `MemberNavInput`, `getMemberNav({ capabilities, hasTelegram, hasTeams })`, `isNavItemCurrent(item, pathname)` in `member-nav.ts`; `MemberNavProvider`, `BuilderNav`, `BuilderAccount` in `builder-nav.tsx`. The menu is derived from the request-cached `currentActor()` plus the store's `hasTeams(userId)` existence check, never the team rows; the layout passes it to the provider and every page composes `BuilderShell` itself | 2 |
| Colosseum integration | validated snapshots, normalized fields, source status | `lib/colosseum-api.ts` extended, `lib/hq/colosseum-snapshot.ts` named only | `claimProject`, `refreshProject`, `listCountryProjects` | 3 |
| Captain service | invitations, redemptions, assignments, leaderboard | `lib/hq/captains.ts` (the service); `lib/hq/actions/captains.ts` (operator actions, gated `requireUser()`, scanned by `tests/hq/operator-imports.test.ts`); `lib/hq/actions/invite.ts` (the one member-gated action, its own module because `actions/captains.ts` is operator-scanned); `lib/hq/invite-exchange.ts` and `lib/hq/invite-continuation.ts` (the `/hq/invite/<token>` exchange and its short-lived continuation, written directly into `hq_auth_verification`) | Invitations: `createCaptainInvitation`, `readCaptainInvitationByToken`, `acceptCaptainInvitation`, `revokeCaptainInvitation`, `listCaptainInvitations`. Assignments: `assignCaptain`, `unassignCaptain`, `clearCaptainAssignments`, `countAssignmentsForCaptain`, `countAssignmentsForUsers`, `listAssignments`, `countAssignmentsByCaptain`. Reads: `leaderboard(db, hackathonId, viewerUserId?)`, `currentCaptainOfProject(db, projectId)`. Operator actions: `createCaptainInvitation`, `revokeCaptainInvitation`, `assignProjectCaptain`, `unassignProjectCaptain`, `bulkAssignProjectCaptain`. Member action: `acceptCaptainInvitationFromContinuation`. Route helpers: `inviteLink(token)`, `INVITE_CONTINUE_PATH` in `lib/hq/member-routes.ts` | 4, complete |
| Reporting service | periods, entries, revisions, completion | `lib/hq/reporting.ts`, named only | `createUpdate`, `editUpdate`, `readAuthorizedUpdates`, `reportingStatus`, `closePeriod` | 5 |
| Telegram adapter | authenticated chat commands, drafts, delivery | `lib/hq/telegram-bot.ts`, `app/api/telegram/webhook/route.ts`, named only | decided in phase 7 | 7 |
| Job runner | reminders, closures, bounded sync | `lib/hq/jobs.ts` named only, `lib/hq/github-actions-auth.ts` parameterised by audience and workflow | `prepareReminder`, with a separate OIDC audience and no shared privileges | 8 |
| Discovery and readiness | final submission readiness | named only | decided in phase 10 | 10 |

Audit event kinds, so that later phases extend one vocabulary instead of
inventing their own: `capability.granted`, `capability.revoked`,
`identity.linked`, `identity.unlinked`, `identity.email_changed`,
`bot.consent_changed`, `person.linked`, `person.match_corrected`,
`captain.invitation_created`, `captain.invitation_revoked`,
`captain.invitation_redeemed`, `captain.assigned` and `captain.unassigned`.
Task T4.1 added the five Captain kinds to `AUDIT_EVENT_KINDS`; task T4.2 is
the first writer of the three invitation kinds and task T4.4 is the first
writer of `captain.assigned`/`captain.unassigned` (with `cause:
"captain_capability_revoked"` in the metadata when the writer is the
revocation cascade rather than a direct unassign) — none is reserved but
unwritten any more. They are the `AUDIT_EVENT_KINDS` union in
`lib/hq/audit-sql.ts`. Note bodies never go into audit. The audit module
exposes no update and no delete, and `tests/hq/capabilities.test.ts` asserts
that.

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

`CapabilityGrant` (`lib/hq/capabilities.ts`) and `AuditEvent`
(`lib/hq/audit-sql.ts`) are **operator-only shapes**, and `listCapabilityGrants`
and `listAuditEvents` are operator-only readers: the rows carry the admin's
free-text grant reason and the operator ids behind a grant, a revocation or any
other change. Neither reader takes an actor, because every caller is already
operator gated and a session read inside `listAuditEvents` would put
`member-auth.ts -> audit.ts -> actor.ts -> member-auth.ts` in a cycle. A member
or Captain surface maps to a view model instead: the phase 4 Captain
leaderboard renders `CaptainLeaderboardView` (`{ rank, displayName,
assignedCount }`), never `CapabilityGrant[]`.

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

### Phase 4 gate

- One-use and multi-use invitation links obey expiry and capacity. "Under
  simultaneous redemption" is proven by capacity arithmetic and source-level
  lock assertions, not true concurrent interleaving — PGlite serializes
  transactions on one connection.
- A link preview (a token read, or a GET exchange), a failed signup and a
  repeat acceptance spend no capacity.
- Link revocation and Captain revocation have separate, documented effects;
  revoking a Captain's grant clears every current assignment it holds, in the
  same transaction as the grant's own revocation.
- A participant cannot be assigned Captain of their own team, whether through
  a verified membership, a linked roster identity, or an unresolved claim
  matched only by the onboarding row's own claimant field.
- A Captain reads only their own team's detail; the leaderboard both a
  Captain and Admin can see carries names and counts only, never an account
  id, a project id or a project link, for anyone but the viewer's own row.

Full detail, including the named test proving each bullet and the two
concurrency and browser-verification limits that apply throughout, is the
phase 4 acceptance checklist in `docs/hq/implementation-log.md`.

Every item in the four lists above is met. The acceptance checklists that name
the test proving each item, and the items explicitly deferred to phases 3, 4, 5
and 7, are in `docs/hq/implementation-log.md`.

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
8. **Changing an existing index's definition** (its predicate, its columns):
   retire the old name with its own `DROP INDEX IF EXISTS <old name>;`
   statement and create the corrected definition under a **new** name with
   `CREATE INDEX IF NOT EXISTS <new name> ...;`. Never reuse the old name for
   a drop-then-create pair. `scripts/hq/migrate.ts` runs each statement
   unwrapped, no transaction, so a same-name pair would run for real on
   *every* future `hq:migrate`, forever, not only the one deploy that needed
   the correction — dropping whatever invariant the index enforces for a
   real window on every deploy after that, and paying an index rebuild each
   time instead of converging to a no-op. T4.1's fix round 2 is the worked
   example: `hq_captain_assignments_current_idx` and
   `hq_captain_assignments_captain_idx` were retired (dropped, never
   recreated) in favour of `hq_captain_assignments_one_current_idx` and
   `hq_captain_assignments_captain_current_idx` under the corrected
   predicate. This is only free while nothing references the old name and no
   database has run it yet; once a table carries live writes under the old
   definition, retiring the name still works but the migration should also
   say so in a comment, the way `builder-schema.sql` now does at that site.

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
  the comment challenge needs the detail endpoint to return the project. As
  of this checkout the fallback is the existing manual review path — but the
  owner's 14 September 2026 change removes that step from phase 3 entirely
  (see "Three consequences of the owner's phase 3 rewrite" below), so this
  limitation stops having a fallback the moment phase 3 lands; it becomes an
  open question the country/edition gate has to answer some other way, not a
  gap manual review quietly covers.
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

## Handoff to phase 3 and phase 5

Phases 0, 1, 2 and 4 are complete. Phase 3 is next: the owner moved it ahead
of phase 5 on 14 September 2026 and rewrote its scope (self-service imports
gated on country and the admin-configured external edition id, no
verification or approval step, join-by-link, admin deletion) — see
`docs/plans/2026-09-13-hq-captains-and-colosseum.md`'s "Instructions for the
next implementing session" for the brief. This section is what phase 3 needs
to start without re-reading the whole log, plus what phase 5 will need
whenever it follows. The per-task detail is in
`docs/hq/implementation-log.md`; this is the short list.

### Interfaces available now

- **Actor and authorization.** `currentActor()`, `requireMemberActor(next?)`,
  `requireOperatorActor()` in `lib/hq/actor.ts`;
  `authorizeProjectAction(actor, { projectId, hackathonId, action }, loaders?)`,
  `requireOperator()`, `isTeamMember`, `isAssignedCaptain`, `entryAudience`,
  `canEditEntry`, `canReadRevisionHistory`, `assertHackathonMatches` in
  `lib/hq/authz.ts`; the pure loaders in `lib/hq/authz-sql.ts`;
  `authorizedTeam`, `memberTeamView`, `TEAM_NOT_AVAILABLE` in
  `lib/hq/member-teams.ts`; `inHackathon(record, hackathonId)` in
  `lib/hq/actions/util.ts`. Every new member-facing read or write goes through
  one of these, never through a second per-action rule.
- **CRM person identity.** `normalizeColosseumUsername`,
  `ensurePersonForAccount`, `ensurePersonForRosterMember`,
  `linkPersonToAccount`, `correctPersonMatch` in `lib/hq/crm-identity.ts`, each
  writing through the query handle it is given so it joins the caller's
  `BuilderDatabase.transaction`.
- **Capabilities and audit.** `grantCapability`, `revokeCapability`,
  `listActiveCapabilities`, `listActiveCapabilitiesForUsers`,
  `listCapabilityGrants`, `personTags` in `lib/hq/capabilities.ts`;
  `recordAuditEvent`, `listAuditEvents` in `lib/hq/audit.ts` over the
  `AUDIT_EVENT_KINDS` vocabulary in `lib/hq/audit-sql.ts`.
- **Identity and login methods.** `getLoginMethods(userId)`,
  `verifiedLoginEmail(user)`, `isVerifiedAccount(user)`, `isPlaceholderEmail`,
  `getTelegramIdentity(userId)`, `hasTelegramIdentity(userId)` in
  `lib/hq/identity.ts`; `getBotConsent`, `setBotConsent`, `revokeBotConsent` in
  `lib/hq/telegram-consent.ts`.
- **Store and view models.** `BuilderStore.profile(userId)`,
  `BuilderStore.hasTeams(userId)`, `BuilderStore.teamById(projectId)`, `BuilderStore.ownClaim(userId,
  projectId)`, `realEmail` in `lib/hq/builder-store.ts`; `builderDatabase()`,
  `BuilderQuery`, `BuilderDatabase`, `atomically()` in `lib/hq/builder-db.ts`;
  `MemberTeamView`, `CaptainAssignmentView`, `PublicPersonView`,
  `CaptainLeaderboardView` and their mappers in `lib/hq/view-models.ts`. A
  member response is built from a view model so it cannot carry an operator
  field; `CapabilityGrant` and `AuditEvent` are operator-only shapes and never
  reach one.
- **Shell and routes.** `MEMBER_PUBLIC_PATHS`, `isMemberPath`, `safeMemberNext`
  in `lib/hq/member-routes.ts`; `getMemberNav({ capabilities, hasTelegram,
  hasTeams })` and `isNavItemCurrent` in `lib/hq/member-nav.ts`. A new phase 3
  member page is one entry in `MEMBER_PUBLIC_PATHS` and, if it needs a menu
  item, one item in `getMemberNav`.
- **Test helpers.** `applyMigrations(pg)` and `pgliteBuilderDatabase(pg)` in
  `tests/hq/helpers/db.ts`.
- **Captain service (phase 4, complete).** `lib/hq/captains.ts`:
  invitations (`createCaptainInvitation`, `readCaptainInvitationByToken`,
  `acceptCaptainInvitation`, `revokeCaptainInvitation`,
  `listCaptainInvitations`), assignments (`assignCaptain`, `unassignCaptain`,
  `clearCaptainAssignments`, `countAssignmentsForCaptain`,
  `countAssignmentsForUsers`, `listAssignments`, `countAssignmentsByCaptain`),
  reads (`leaderboard`, `currentCaptainOfProject`). `hq_captain_assignments`
  is `CLEAR` on `hq:reset` (a project's Captain only means something for a
  project that still exists); `hq_captain_invitations` and
  `hq_captain_invitation_redemptions` are `KEEP` (account-level grant
  history). Relevant to phase 3's admin deletion feature: deleting an
  `hq_projects` row cascades into `hq_captain_assignments`
  (`ON DELETE CASCADE`), so a deleted project's Captain history goes with it;
  deleting an `hq_builder_profiles` row (a person) does **not** remove that
  account's invitation, redemption or assignment rows — the foreign keys are
  `ON DELETE SET NULL`, so the rows survive as history with a null actor,
  which is what the non-replenishment rule and the leaderboard's "revoked
  Captain disappears" behaviour both depend on.

### Three consequences of the owner's phase 3 rewrite

Recorded here, not only in the untracked plan file, because a session
working from the repository checkout alone must not be left with a pointer
to a file that is not in it. The owner's 14 September 2026 change removed
Phase 3's verification/approval step entirely and added self-service
join-by-link and admin deletion; three things in the existing codebase must
be handled as a result, not discovered mid-task.

1. **The `verification = 'verified'` decision.**
   `lib/hq/authz-sql.ts#loadTeamMembership` requires
   `o.verification = 'verified'`, and `lib/hq/member-teams.ts`,
   `lib/hq/builder-store.ts#updateTeam` and `redeemInvite` all lean on that
   column being set correctly. Removing the verification *step* does not
   mean dropping the column blind: phase 3 must choose between writing
   `'verified'` on a successful import (the smallest change — every existing
   reader keeps working unmodified) or retiring the concept and following
   every one of those readers to a replacement rule. Either way, the choice
   must not leave a membership check that no import can ever satisfy, which
   would silently break every "verified team member" authorization path.
2. **The admin review surface becomes vestigial.** `reviewBuilderProject` in
   `lib/hq/actions/builders-admin.ts`, the verification controls in the
   "Imported teams" panel (`components/hq/builder-admin.tsx`), and
   `hq_project_onboarding.verification` / `proof_comment_id` /
   `proof_author_id` exist to support a step phase 3 removes. Remove what is
   dead rather than leaving controls that do nothing — a control with no
   effect is worse than no control, because it tells the operator a review
   step still happens.
3. **Admin deletion reaches further than `hq_captain_assignments`.** The
   "Captain service" row above already covers what deleting an `hq_projects`
   or `hq_builder_profiles` row does to phase 4's tables. Phase 5, once it
   exists, will add reporting rows (updates, entries, revisions) that will
   also reference a project and an author account, and those tables do not
   exist yet at this checkout. If phase 3's deletion feature lands before
   phase 5's tables do, it cannot handle rows that do not yet exist — but
   phase 5 must then check what phase 3 built and extend it, rather than
   assuming phase 3's deletion is already complete for a project or a
   person once phase 5's tables are added. Whichever phase is implemented
   second should read this note and confirm deletion handles both.

### What phase 3 also inherits from phase 4

`assignCaptain`'s conflict check (`lib/hq/captains.ts#checkCaptainConflict`)
has a second source — a linked imported-roster identity — that is
**unreachable today**: every roster row's `person_id` is `NULL` until a
roster import creates one, so the check can only ever resolve a roster row
once someone has joined it directly. The moment phase 3 wires
`ensurePersonForRosterMember` into the import path, roster rows start
carrying real `person_id` values, and `assignCaptain`'s conflict check and
`correctPersonMatch` (an operator action, `lib/hq/crm-identity.ts`) start
sharing state with **no lock between them**: an admin correcting a person
match at the same moment another admin assigns a Captain to a project that
match's roster row belongs to could, in principle, land the very state T4.4
closed for its other two races (a participant Captaining their own team).
T4.4's own report names this explicitly and defers the decision — whether
`checkCaptainConflict`'s roster scan needs to lock `hq_project_members`/
`hq_crm_persons` the way it already locks `hq_project_onboarding`, or
whether this is rare and operator-triggered enough on both sides to leave
unlocked — to whoever implements phase 3.

### The fallback asset

Source `docs/plans/assets/hq-project-fallback.png` (untracked in this checkout;
a copy is kept at
`.superpowers/sdd/2026-09-13-hq-captains-and-colosseum/hq-project-fallback.png`).
Phase 3 copies it to `public/images/hq/project-fallback.png` and references that
target path. See "Companion asset" above.

### The unverified Colosseum edition

The World's Fair external Colosseum id and slug are **unverified** and must not
be guessed, seeded or hard coded. External id 6 is the finished **Frontier**
edition, slug `frontier`. An edition with external id 7 exists but its project
directory is disabled, so its name, slug and dates cannot be read from the
public API. The operator types the confirmed id and slug into Admin, under
Builder onboarding, and they are stored in `hq_hackathon_onboarding`. The `6`
that appears inside HQ is the internal `hq_hackathons.id`, not Colosseum's id;
never copy it into the external mapping. A "Dutch registrations" view must say
"edition not available", never 0.

### Fixtures

`tests/hq/fixtures/colosseum/`: `directories.json`, `listing.json`,
`detail.json`, `errors.json` and a `README.md` that records provenance and which
shapes are assumptions. Every project, roster, handle, display name, avatar URL
and project id in them is invented. Phase 3 extends these files rather than
inlining new response shapes, and `tests/colosseum-api.test.ts` already
validates `detail.json`'s `submitted` entry against `projectSchema` on every
run. `detail.json`'s `unsubmitted` entry is a structural assumption, unverified
against a live draft.

### Four notes phase 3 must not rediscover

1. **Import then claim is `ensurePersonForRosterMember` plus a
   `correctPersonMatch` merge.** The roster import creates or reuses a person by
   normalized Colosseum username with `ensurePersonForRosterMember`, never by
   display name. When that person's human later signs in, the account already
   has its own person from `ensurePersonForAccount`, so joining the two is the
   merge branch of `correctPersonMatch(db, { personId, toUserId, reason, actor
   })`: cards and roster rows are re-pointed onto the survivor, the provisional
   username moves, the merged person is deleted and `person.match_corrected` is
   recorded, all in one transaction. Do not add a second link path, and do not
   call `linkPersonToAccount` for this case; it refuses an account that already
   holds a person.
2. **`hq_people_person_idx` is `(hackathon_id, person_id)` unique where
   `person_id IS NOT NULL`:** one People card per person per edition. Once
   phase 3 creates People cards for roster persons, two cards of the same
   edition can carry the same person, so every writer needs the guard the
   backfill, the link stamp and `enroll()` already have (stamp only when no
   other card of that edition carries the person, and report the collision
   rather than failing). `correctPersonMatch` already reports an unstamped
   colliding card in its result.
3. **Remove the hard-coded `HACKATHON_ID = 6` in
   `lib/hq/colosseum-interest.ts`.** It is the internal `hq_hackathons.id` of
   the current edition written as a constant, which is exactly what the standing
   rule forbids. Phase 3 takes the edition from the selection the rest of HQ
   already uses and removes the constant.
4. **Phase 7 joins bot consent on the identity row.** Permission to message
   someone lives in `hq_telegram_bot_consent` (`user_id`, `telegram_user_id`,
   `messaging_enabled`), and the Telegram account to message lives in
   `hq_auth_telegram_identity`. Delivery must join the two and send only where
   `messaging_enabled` is true and an identity row still exists; disconnecting
   Telegram already revokes consent in the same operation. Nothing reads the
   consent row to send anything today.

### What phase 5 needs from phase 4

Phase 5 (reporting) is next after phase 3 in the plan's current order, but
these facts are recorded now, while they are fresh, rather than left for
whoever implements phase 5 to re-derive:

- **Assignment records are real.** `lib/hq/captains.ts#listAssignments(db, {
  hackathonId, captainUserId? })` returns every project's current Captain in
  an edition, or one Captain's own current projects there;
  `countAssignmentsByCaptain(db, hackathonId)` is the indexed, edition-scoped
  aggregate behind the leaderboard; `currentCaptainOfProject(db, projectId)`
  is the single-project lookup `lib/hq/member-teams.ts#memberTeamView` already
  uses to populate a team's own view of its Captain. None of the three takes
  an actor — the caller gates itself and chooses what to pass, the same
  pattern `listCapabilityGrants`/`listAuditEvents` already established.
- **`loadCurrentAssignment(db, projectId)` in `lib/hq/authz-sql.ts` now reads
  real rows** from `hq_captain_assignments` (`{ captainUserId }` or `null`),
  not an always-null stub. `authorizeProjectAction`'s Captain-assignment
  branch in `lib/hq/authz.ts` was already tested against injected fixtures in
  phase 1 and needed no change when the real loader landed; phase 5's own
  entry-visibility decisions can rely on it the same way.
- **What `loadEntry(db, entryId)` still needs.** Still the phase-1 stub in
  `lib/hq/authz-sql.ts` (`export const loadEntry: EntryLoader = async () =>
  null;`). Its signature and result type (`Entry = { id, projectId,
  hackathonId, authorUserId, visibility: "shared" | "sensitive" }`) were
  fixed before phase 5's own reporting-entry table exists, the same way
  `loadCurrentAssignment`'s were fixed before phase 4's tables existed. Phase
  5 creates that table, then replaces only this function's body — the
  decision logic over it in `lib/hq/authz.ts` (`canEditEntry`,
  `entryAudience`) is already written and tested with injected fixtures, and
  should need no change.
- **A known UX gap phase 5 will meet again if it also renders a Captain's
  assignments.** `app/hq/(member)/captain/page.tsx` falls back to a
  reduced `{ projectId, projectName }` card for an assignment to a project
  with no `hq_project_onboarding` row (an admin-created CRM entry with no
  self-serve team) — `CaptainAssignmentView` needs a `BuilderTeam`, which
  such a project does not have. If phase 5's reporting UI also lists a
  Captain "their" projects, it will hit the same gap and should decide
  deliberately rather than rediscover it.
