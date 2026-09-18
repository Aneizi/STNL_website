# HQ module contracts

The agreed module boundaries, entry points and conventions for the Captains and
Colosseum plan (`docs/plans/2026-09-13-hq-captains-and-colosseum.md`). This file
is a reference, not a plan. It says where a thing belongs, what it is called and
which phase creates it, so that later phases do not re-invent a boundary or
guess a path.

Two standing rules:

1. **No stub source files.** Phases 0–8 and 10 now have implementations. Keep
   future work in the plan until it has a caller and an authorized use. Phase 9
   remains removed.
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

The Telegram OIDC parser accepts a positive safe integer or its canonical
decimal string in the signed profile `id` claim. It normalizes that claim
before the identity store converts it to a string. Malformed or unsafe values
remain invalid; the OIDC `sub` is a separate account key and never substitutes
for the bot-facing Telegram user id.

A public role never creates operator access. `requireOperator()` in the
authorization module is a thin wrapper over `requireUser()`, and there is no path
from a public account to an `hq_users` row.

## Module to file map

Phase column is the phase that creates the module. "Named only" means no file
exists yet and none should be created before that phase.

| Module | Owns | Repo files | Typed entry points | Phase |
|---|---|---|---|---|
| Identity | verified login identities, sessions, linking, optional contact email | `lib/hq/member-auth.ts`, new `lib/hq/telegram-provider.ts`, new `lib/hq/telegram-identity-plugin.ts`, new `lib/hq/identity.ts`, `lib/hq/actions/telegram.ts` (member gated); task T4.2 added `lib/hq/placeholder-email.ts` (`PLACEHOLDER_DOMAIN` and `isPlaceholderEmail` are defined here — the one leaf module with no `server-only` and no Better Auth import — and re-exported, unchanged, from `telegram-provider.ts` and `identity.ts` for every existing caller) | `isPlaceholderEmail(email)`, `getLoginMethods(userId)`, `hasTelegramIdentity(userId)`, `getTelegramIdentity(userId)`, `verifiedLoginEmail(user)`, `isVerifiedAccount(user)` (the one definition of "verified account"; every session reader imports it); phase 2: `isRecentSession(session)` and `telegramIsLastLoginMethod(user)` (the one recency rule and the one last-login-method rule, enforced by the plugin's before hooks and read by the confirmation actions), `recordTelegramIntent(store, userId, intent)`, `currentMemberSession()` (its `user.email` is null for a Telegram-only account: a `customSession` transform replaces the internal placeholder on `/get-session`, and so on every reader of a session, `StoredAccount.email` being `string | null` for that reason), `redirectToMemberSignIn(next)`, and the actions `confirmLinkTelegram()`, `confirmUnlinkTelegram()`; task T2.3: `confirmEmailChange(newEmail)` (the confirmation before the emailOTP change-email endpoints; the intent is bound to the address; since the account page redesign it serves an account that already has a verified login email too, the code going to the new address only, an accepted trade-off the action's comment records, with `EMAIL_UNCHANGED` for the current address), `normalizeEmailAddress(value)`, the `user.update.after` hook in `member-auth.ts` (notifies the previous verified real address and records `identity.email_changed`), and in `lib/hq/telegram-consent.ts` `getBotConsent(userId)`, `setBotConsent(actor, enabled)`, `revokeBotConsent(userId, db)` with the action `setBotMessaging(enabled)` | 0 spike, then 1 and 2 |
| Authorization | operator checks, capabilities, membership, assignment, note audience | `lib/hq/authz.ts` (the one module a caller imports) over the session-free decisions in `lib/hq/authz-decisions.ts` and the pure loaders in `lib/hq/authz-sql.ts`; member-facing team reads over the decision in `lib/hq/member-teams.ts`; operator actions resolve record ids through `inHackathon` in `lib/hq/actions/util.ts` | `getActorCapabilities(actor)`, `authorizeProjectAction(actor, { projectId, hackathonId, action }, loaders?)` returning `Authorization`, `requireOperator()`, `isTeamMember(actor, projectId)`, `isAssignedCaptain(actor, projectId)`, `entryAudience(entry, actor)`, `canEditEntry(actor, entry)`, `canReadRevisionHistory(actor)`, `assertHackathonMatches(record, hackathonId)`; loaders are injectable per call and never cached across requests. The typed hooks `loadCurrentAssignment(db, projectId)` (reads `hq_captain_assignments` since task T4.1) and `loadEntry(db, entryId)` (reads `hq_reporting_entries` since task T5.2, with an operator author namespaced as `operator:<id>`) live in `authz-sql.ts`; the decisions over them are tested with injected fixtures, independent of whether the loader body is real, and neither phase needed a change to `Entry`, `CurrentAssignment`, `entryAudience` or `canEditEntry`. `assertHackathonMatches` is defined in `authz-sql.ts` and re-exported from `authz.ts`: it reads no session, and `actions/util.ts` imports it from the leaf so the operator action modules do not reach the member auth graph (`tests/hq/operator-imports.test.ts`). Phase 6 split that reasoning one level further: every decision above lives in `authz-decisions.ts`, which imports `Actor` as a type only, and `authz.ts` re-exports all of them and keeps `requireOperator()`, the one function here that reads a session. `lib/hq/reporting.ts` imports the decisions leaf for that reason and nothing else; every other caller imports `./authz`. `authorizedTeam(actor, { projectId, hackathonId?, action })` and `memberTeamView(actor, projectId)` return null for every denial; `inHackathon(record, hackathonId)` returns null for a missing record and for one from another edition alike | 1 |
| Capability grants | grant and revoke, one effective grant per capability, audit trail | `lib/hq/capabilities.ts`, `lib/hq/actions/capabilities.ts` (operator gated) | `Capability = "captain"`, `grantCapability(db, { actor, byOperatorId, userId, capability, reason })` and `revokeCapability(db, ...)` (idempotent, the only writers of `hq_account_capabilities`, audit event in the same transaction). `actor` is the `AuditActor` the event records, `byOperatorId` the `hq_users` id the row is attributed to (`granted_by_user_id` / `revoked_by_user_id`) or null: a member redeeming a Captain invitation in phase 4 is a member actor with the inviting operator as `byOperatorId`. Grants are account-global, never scoped to an edition. Also `listActiveCapabilities(userId)`, `listActiveCapabilitiesForUsers(userIds)`, `listCapabilityGrants({ capability, activeOnly? })`, `personTags(roleLabel, capabilities)`; actions `grantCaptainCapability(userId, reason)`, `revokeCaptainCapability(userId, reason)` | 1 |
| CRM person identity | stable person id, account link, edition People references, explicit correction | `lib/hq/crm-identity.ts`, `lib/hq/queries.ts`, `lib/hq/actions/people.ts` | `normalizeColosseumUsername(raw)`, `ensurePersonForAccount(db, { userId, displayName })`, `ensurePersonForRosterMember(db, { colosseumUsername, displayName })`, `linkPersonToAccount(db, { personId, userId })` (each writes through the query handle it is given, so it joins the caller's `BuilderDatabase.transaction`), `correctPersonMatch(db, { personId, toUserId, reason, actor })` (detach, link, or merge into the account's own person; never by display name) and the operator action `correctPersonMatch({ personId, toUserId, reason })` | 1, used from 3 |
| Audit | append only metadata events | `lib/hq/audit.ts`, `lib/hq/audit-sql.ts` | `recordAuditEvent(db, { kind, actor, subjectUserId?, hackathonId?, projectId?, metadata? })`, `listAuditEvents(filter, { limit, cursor })`; nothing else | 1 |
| Actor aware response types | the smallest DTO per audience | new `lib/hq/view-models.ts` | `MemberTeamView`, `CaptainAssignmentView`, `PublicPersonView`, `CaptainLeaderboardView` (`{ rank, displayName, assignedCount, isYou }`; `assignedCount` and `isYou` filled by task T4.5, `toCaptainLeaderboardView`) | 1, filled by 4 |
| Shell and navigation | capability driven member menu, one member route list | new `lib/hq/member-routes.ts`, new `lib/hq/member-nav.ts` (both pure and client-safe), new `components/hq/builder-nav.tsx`, `components/hq/builder-shell.tsx`, new `app/hq/(member)/layout.tsx` (a provider, **not** the auth boundary) | `MEMBER_PUBLIC_PATHS`, `isMemberPath(pathname)`, `safeMemberNext(value)` in `member-routes.ts`; `NavItem`, `MemberNavInput`, `getMemberNav({ capabilities, hasTelegram, hasTeams })`, `isNavItemCurrent(item, pathname)` in `member-nav.ts`; `MemberNavProvider`, `BuilderNav`, `BuilderAccount` in `builder-nav.tsx`. The menu is derived from the request-cached `currentActor()` plus the store's `hasTeams(userId)` existence check, never the team rows; the layout passes it to the provider and every page composes `BuilderShell` itself | 2 |
| Colosseum integration | validated snapshots, normalized fields, source status | `lib/colosseum-api.ts` (HTTP and error taxonomy), `lib/colosseum-schema.ts` (the ONE place upstream field names are written down), `lib/hq/colosseum-snapshot.ts` (pure normalization and the submission interpretation), `lib/hq/project-import.ts` (the gate and the import/refresh entry points) | `fetchColosseumProject`, `fetchEditionSubmissionWindow` (the one reader of `hackathons[].projectSubmissionEndDate`), `isRetryable`; `interpretSubmission` (the ONE writer of `submission_status`; `DRAFT_SIGNAL_CONFIRMED` gates whether a null `submittedAt` may read as Not submitted), `toSnapshotFields`, `groupedMaterials`, `submittedOnTime`, `PROJECT_FALLBACK_IMAGE`; `gateProject`, `importColosseumTeam`, `refreshColosseumTeam`, `importFailureFor`, `inviteRetry`. `listCountryProjects` was never built: phase 9, the discovery list it existed for, was removed by the owner | 3, complete |
| Captain service | invitations, redemptions, assignments, leaderboard | `lib/hq/captains.ts` (the service); `lib/hq/actions/captains.ts` (operator actions, gated `requireUser()`, scanned by `tests/hq/operator-imports.test.ts`); `lib/hq/actions/invite.ts` (the one member-gated action, its own module because `actions/captains.ts` is operator-scanned); `lib/hq/invite-exchange.ts` and `lib/hq/invite-continuation.ts` (the `/hq/invite/<token>` exchange and its short-lived continuation, written directly into `hq_auth_verification`) | Invitations: `createCaptainInvitation`, `readCaptainInvitationByToken`, `acceptCaptainInvitation`, `revokeCaptainInvitation`, `listCaptainInvitations`. Assignments: `assignCaptain`, `unassignCaptain`, `clearCaptainAssignments`, `countAssignmentsForCaptain`, `countAssignmentsForUsers`, `listAssignments`, `countAssignmentsByCaptain`. Reads: `leaderboard(db, hackathonId, viewerUserId?)`, `currentCaptainOfProject(db, projectId)`. Operator actions: `createCaptainInvitation`, `revokeCaptainInvitation`, `assignProjectCaptain`, `unassignProjectCaptain`, `bulkAssignProjectCaptain`. Member action: `acceptCaptainInvitationFromContinuation`. Route helpers: `inviteLink(token)`, `INVITE_CONTINUE_PATH` in `lib/hq/member-routes.ts` | 4, complete |
| Record deletion | admin removal of a team and of a person | `lib/hq/record-deletion.ts`; operator actions in `lib/hq/actions/builders-admin.ts` (`deleteBuilderTeam`), `lib/hq/actions/people.ts` (`deletePerson`) and `lib/hq/actions/projects.ts` (`deleteProject`, which delegates here so there is one deletion, not two) | `teamRemovalImpact`, `deleteTeamRecord`, `personRemovalImpact`, `deletePersonRecord`. One transaction each, audited (`project.deleted`, `person.deleted`), real counts read before the destructive step and again inside it. Deleting a person NEVER deletes the `hq_builder_profiles` account behind them | 3 |
| Reporting service | periods, eligibility, entries, revisions, completion, outcomes | `lib/hq/reporting.ts` (the one module a caller imports), `lib/hq/reporting-enrolment.ts` (schedule and eligibility, split out **only** so `builder-store.ts` can enrol a team inside the import transaction without `./authz -> ./actor -> ./member-auth -> ./builder-store` closing a cycle; everything it owns is re-exported unchanged), `lib/hq/reporting-periods.ts` (the pure generator, no `server-only`) | Schedule: `readReportingSchedule`, `listReportingPeriods`, `currentReportingPeriod`, `ensureReportingPeriods`, `previewReportingPeriods`. Eligibility: `reportingEligibility`, `listReportingEligibility`, `enableReporting`, `pauseReporting`. Entries: `createUpdate`, `editUpdate`, `voidUpdate`, `readAuthorizedUpdates`, `readRevisionHistory`, `MAX_BODY_LENGTH`. Status and outcomes: `reportingStatus`, `closePeriod`, `listPeriodOutcomes`, `correctOutcome`. Pure: `generateReportingPeriods`, `zonedDateTimeToUtc`, `addDays`, `periodForInstant` | 5, complete |
| Reporting surfaces | the team, Captain and admin reporting screens and the actions behind them | `lib/hq/reporting-view.ts` (pure copy and presentation rules, client-safe), `lib/hq/reporting-contacts.ts` (the two opt-in contacts, no `./authz` import so operator queries reach it), `lib/hq/reporting-surface.ts` (the two member page reads), `lib/hq/actions/reporting.ts` (member gated), `lib/hq/actions/reporting-admin.ts` (operator gated, scanned by `tests/hq/operator-imports.test.ts`), `components/hq/reporting-member.tsx`, `components/hq/reporting-entry-card.tsx` (the entry card the team page and the Captains' Den share), `components/hq/reporting-admin.tsx`, `components/hq/reporting-project-panel.tsx` | Member actions: `addReportingUpdate`, `editReportingUpdate`, `saveTeamContact`, `saveCaptainContact`. Operator actions: `previewReportingSchedule`, `applyReportingSchedule`, `saveReportingConfiguration`, `enableProjectReporting`, `setProjectReportingPaused`, `voidReportingUpdate`, `correctReportingOutcome`, `loadProjectReporting`, `loadEntryRevisions`. Pure: `statusLabel`, `periodRangeLabel`, `periodRangeShortLabel`, `deadlineLabel`, `dueLabel`, `dueLine`, `weekOfLabel`, `dayMonthLabel`, `entryMetaLabel`, `captainMetaLabel`, `telegramContactHref`, `isWeekStarted`, `isWeekCurrent`, `shouldPromptUpdate`, `promptDismissKey`, `byOutstandingFirst`, `ADD_UPDATE_MESSAGES`, `EDIT_UPDATE_MESSAGES`, `AUDIENCE_NOTES`, `normalizeContact`, `MAX_CONTACT_LENGTH`. Reads: `teamReportingPanel`, `captainReportingBoard`, `readTeamContact(s)`, `readCaptainContact(s)`, `readCaptainHandle` (the Telegram username first, the typed contact as the fallback). A phase that writes reporting copy adds it to `reporting-view.ts`, so the em dash and middot scan keeps covering it | 6, complete |
| Telegram adapter | authenticated chat commands, drafts, delivery | `lib/hq/telegram-bot.ts` (the deterministic flow), `lib/hq/telegram-bot-view.ts` (pure copy, escaping and keyboards, client-safe like `reporting-view.ts`), `lib/hq/telegram-bot-store.ts` (receipts, callback references, drafts, the outgoing queue and the chat binding), `lib/hq/telegram-bot-api.ts` (the transport, the only module that holds the token), `lib/hq/telegram-webhook.ts` (the endpoint's own rules), `app/api/telegram/webhook/route.ts` (the address) | Flow: `handleTelegramUpdate(update, { db?, now?, hqOrigin? })` returning `{ replies, answer, queued, outcome }`. Endpoint: `handleTelegramWebhookRequest(request, deps?)`, `secretMatches`, `telegramUpdateSchema`, `readBoundedBody`, `MAX_WEBHOOK_BODY_BYTES`, `SECRET_HEADER`. Transport: `telegramBotConfig(env)`, `isTelegramBotConfigured`, `telegramSender(config)`, `redactBotUrl`, `TelegramSender`. Store: `claimTelegramUpdate` (leased, so an interrupted update is retried), `finishTelegramUpdate`, `bindBotChat`, `deliverableBotChat`, `botMessagingEnabled`, `createBotAction`, `readBotAction` (resolves, never consumes), `consumeBotAction` (inside the writing transaction), `isWriteAction`, `isDraftAction`, `readBotDraft`, `startBotDraft` (new generation), `advanceBotDraft` (same generation, next revision), `claimBotDraft` (the logical-save claim), `clearBotDraft`, `enqueueBotMessage`, `flushBotMessages` (claimed batches, consent re-checked before dispatch), `purgeExpiredBotState`. Identity: `telegramMemberActor(telegramUserId, db?)` in `lib/hq/actor.ts` over `findTelegramIdentityByTelegramUserId` in `lib/hq/identity.ts`. View: `escapeHtml`, `inlineKeyboard`, `packMessages`, `chunkForEscaped`, `TELEGRAM_TEXT_LIMIT`, `BOT_COPY`, `LABELS`, `previewMessages`, `savedMessage`, `periodChangedMessages`, `conflictMessages`, `refusalMessages`, `ownNoteMessages`, `projectMessage`, `projectListLine`, `weekLine`, `snippet`, `page` | 7, complete |
| Job runner | reminders, closures, bounded sync | `lib/hq/jobs.ts` (the one module a caller imports), `lib/hq/github-actions-auth.ts` parameterised by audience and workflow (`ScheduledJob`, `isTrustedJobClaims`, `isTrustedJobRequest`), `app/api/cron/hq-jobs/route.ts`, `.github/workflows/hq-jobs.yml`, `lib/hq/actions/jobs.ts` (operator gated, the manual retry and the admin read) | `dueReminders`, `prepareReminder`, `expireStaleReminders`, `reconcileReminderDeliveries`, `purgeReminderDeliveries`, `closeDuePeriods`, `listReminderDeliveries`, `runDueWork`; constants `REMINDER_TYPE_WEEKLY`, `REMINDER_MAX_AGE_MS`, `REMINDER_RETENTION_MS`; the `ReminderSkipReason` vocabulary. Its own OIDC audience (`HQ_JOBS_AUDIENCE`, `stnl-hq-jobs`) and its own workflow file, no shared privileges and no stored secret. Delivery is phase 7's, untouched: `deliverableBotChat` names the chat, `enqueueBotMessage` with a reminder `dedupeKey` writes the message inside the job's transaction, and `flushBotMessages` sends it and records the result. Operator actions: `runReportingJobsNow`, `loadReminderDeliveries` | 8, complete |
| Final submission | material readiness, submission snapshots and historical reconciliation | `lib/hq/submission-readiness.ts` (pure checklist), `lib/hq/submission.ts` (snapshots and bounded jobs), `components/hq/submission-focus.tsx` (shared authorized view) | `readSubmissionSnapshots`, `readSubmissionReconciliations`, `listSubmissionReconciliations`, `dueSubmissionRefreshes`, `refreshDueSubmissions`, `openSubmissionReconciliations`, `reconcileSubmissions`; surface authorization stays in `reporting-surface.ts`, submission truth stays in `colosseum-snapshot.ts` | 10, complete |

Audit event kinds, so that later phases extend one vocabulary instead of
inventing their own: `capability.granted`, `capability.revoked`,
`identity.linked`, `identity.unlinked`, `identity.email_changed`,
`bot.consent_changed`, `person.linked`, `person.match_corrected`,
`captain.invitation_created`, `captain.invitation_revoked`,
`captain.invitation_redeemed`, `captain.assigned`, `captain.unassigned`,
and phase 3's `project.imported` (the first member-actor project event),
`project.deleted` and `person.deleted`; and phase 5's
`reporting.eligibility_changed`, `reporting.entry_voided`,
`reporting.outcome_corrected` and `reporting.period_closed` (the first
`system`-actor kind, written when a job closes a period). Reporting content
is never audited: the four kinds record decisions about entries, never their
text. `tests/hq/capabilities.test.ts` pins the exact list, so a phase adding
a kind updates it there too.
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
People grants and removes Captain through `setPersonCaptain(personId,
captain)` (`lib/hq/actions/people.ts`): it resolves the card's own
`builder_user_id` within the selected edition, refuses a hand-entered card,
and delegates to `grantCaptainCapability` / `revokeCaptainCapability` with
the fixed reasons "Granted from People" and "Removed from People", so the
grant, its audit event and (on revoke) the clearing of current project
assignments stay in `lib/hq/actions/capabilities.ts`. Editing a role or a tag
still cannot grant `captain`: the grant is an explicit action on the linked
account, never a role edit.

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

### Team import and joining (updated 16 September 2026)

- A Dutch project in the configured external edition is previewed first.
  The importer selects their Colosseum teammate, then the import atomically
  binds that entry to their signed-in account. There is no approval queue.
- A non-Dutch project, another edition, an unconfigured edition mapping, a
  malformed URL, a 404, a timeout, a 429, an unreadable body and an already
  imported team each produce their own message; none is generic, and
  Colosseum's own error text never reaches the browser.
- An already-imported team offers the Superteam NL Telegram group as a logo
  control with an accessible name, and reveals nothing about who imported it.
- Each team has a reusable link that verified teammates can share. Each
  person selects an unclaimed entry from the current Colosseum roster. One
  account can claim one entry per project; concurrent claims are serialized.
  Existing single-seat links retain their original expiry and use rules.
  The database keeps their two-day expiry default for older app instances
  during deployment; reusable links explicitly store no expiry.
- Colosseum roster entries are source references. Import and refresh do not
  create People records for unclaimed teammates. Claiming an entry links it
  to the account's person, reusing existing identity records where needed.
- If no entry is available, the join page asks the person to add themselves
  on Colosseum and refresh. Roster refresh checks project identity, country
  and edition before updating available entries.
- A project imported twice creates no duplicate team and no duplicate People
  identity; refresh is idempotent and retains membership, notes and the
  Captain assignment.
- Deleting a team and deleting a person each run in one transaction, are
  audited, confirm real counts beforehand, and leave the HQ account intact.

Full detail, and the acceptance checklist naming the test behind each bullet,
is in `docs/hq/implementation-log.md`.

Every item in the five lists above is met. The acceptance checklists that name
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
   Seeded-row edits such as the two liaison-role renames ("Captain" to
   "Partner captain", then "Partner captain" to "Partner contact") stay in
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

### Project link input (updated 2026-09-16)

`parseColosseumProjectUrl` accepts public
`https://colosseum.com/arena/projects/<slug>` links and saved legacy
`/arena/projects/explore/<slug>` links. It strips outer whitespace, an optional
trailing slash, query parameters and fragments. It validates HTTPS, the exact
host and slug before any request; credentials, extra path segments, bare
directories and literal/encoded dot segments are rejected without fetching.
Only the validated slug enters the fixed API request
`https://api.colosseum.com/api/project?slug=<slug>&type=HACKATHON`.
Imports, operator source attachment and help requests use the shared
`colosseumProjectUrl` formatter to save the direct public URL.
The legacy path is retained for the special slug `explore` to avoid confusing
that project with the bare directory when refreshing it.

### API observations

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
- **Ownership proof before submission is not possible** through the API. This
  stopped being a gap phase 3 had to cover: the owner removed ownership proof
  entirely on 14 September 2026, and the country/edition gate is now the whole
  answer. What HQ actually relies on is that a project's Colosseum page is
  public, so the first person from a Dutch team to paste the link owns it in
  HQ; anyone else on that team joins with a link from them, and anyone who
  believes the wrong person imported it is routed to the Superteam NL
  Telegram group, where an admin can delete the team. That is the owner's
  chosen trade, recorded here so nobody re-derives it as an oversight.
- **`submittedAt` is the submission signal**, and as of 2026-09-14 its draft
  behaviour is **verified, not assumed**: a live in-flight project returned
  the field present and null, a finished-edition project returned a
  timestamp, both unauthenticated through the detail endpoint.
- **`projectCompletion` is a readiness diagnostic** and must never drive a
  "Submitted" badge. Correction from 2026-09-14: the **public** detail
  endpoint does not return it at all (presumably owner-authenticated), so
  `completion_is_complete` stays NULL in practice and the readiness line
  never renders. The schema keeps it optional and the element type of
  `fieldErrors` remains unverified.
- **No sort by submission date**, and as of 2026-09-14 **`sort` is required**
  on `GET /api/projects` (omitting it answers 400 "Invalid discriminator
  value. Expected 'RANDOM' | 'NAME'"). A "new submissions since X" poll would
  have to page the country subset and diff by id and `submittedAt`.
- **A listing row's `slug` is not always slug-shaped.** A real Frontier
  project carries `""or""or`. `listingSchema` therefore does not validate
  listing rows at all, so one pathological project cannot take an edition's
  submission window down with it; the detail endpoint keeps strict
  validation. A team whose slug is not slug-shaped could not import — an
  accepted edge, not worth loosening the URL parser for.
- **Error bodies are discarded today.** ~~Every non 2xx other than 404 and 429
  collapses to `UNAVAILABLE`~~ — **closed by phase 3**: `lib/colosseum-api.ts`
  reads the body's `code` and `message` and gives a 4xx its own
  `SOURCE_REJECTED`, so "directory disabled" and "unknown edition" are now
  distinguishable. The text is carried as data, never shown.
- **Rate limits are unknown.** No 429 was observed. A listing refresh must be
  server side, bounded, cached, and must show the last successful refresh time.
- **Images and avatars are on a third party host**,
  `static.narrative-violation.com`. Phase 3's decision: do **not** proxy them.
  `components/hq/builder-project-image.tsx` renders a plain `<img>` so the
  viewer's browser fetches the image directly, with `referrerPolicy`
  `no-referrer` and a local fallback; no Colosseum host is in
  `remotePatterns` and none should be added, because `next/image` would make
  this application fetch and re-serve arbitrary remote bytes.
- **The client's zod objects are not strict.** Unknown fields survive only
  inside the retained `raw` snapshot, and a renamed `teamMembers` would surface
  as a generic `INVALID_RESPONSE` rather than a precise error.

Client gaps as of phase 3: closed, except deliberately.
`fetchEditionSubmissionWindow` parses the `hackathons` envelope with the
bracket array form; `submittedAt`, `projectCompletion`, `category`, `tracks`
and `twitterHandle` are in `lib/colosseum-schema.ts` and on `ImportedProject`;
`hq_project_onboarding` stores the submission status, the last successful
check and the last failure. Left out on purpose: a general listing client
(nothing needs one now that phase 9 is removed), and `comments` /
`isUniversityProject`, which no surface shows — the comment client went with
the ownership-proof challenge.

## Companion asset

The approved project fallback image:

- **Source:** `docs/plans/assets/hq-project-fallback.png`, untracked in this
  checkout. A copy is kept at
  `.superpowers/sdd/2026-09-13-hq-captains-and-colosseum/hq-project-fallback.png`.
- **Target, phase 3: DONE.** `public/images/hq/project-fallback.png`,
  referenced through `PROJECT_FALLBACK_IMAGE` in
  `lib/hq/colosseum-snapshot.ts` and rendered by
  `components/hq/builder-project-image.tsx`.

The plan's original path, `assets/hq-project-fallback.png`, does not exist at the
repository root. Phase 3 copied the source above to the target path.

## Handoff to phase 11

Phases 0, 1, 2, 3, 4, 5, 6, 7, 8 and 10 are complete. **Phase 11 (verify,
prepare deployment and release progressively) is next**; there is no phase 9. This
section is what a later phase needs to start without re-reading the whole
log. The per-task detail is in `docs/hq/implementation-log.md`.

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
  `BuilderDatabase.transaction`. Roster entries receive a `person_id` when
  claimed. Import and joining reuse the signed-in account's person; older
  pre-created roster identities are reconciled when claimed.
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
  `BuilderStore.hasTeams(userId)`, `BuilderStore.teamById(projectId)`,
  `realEmail` in
  `lib/hq/builder-store.ts`; `builderDatabase()`, `BuilderQuery`,
  `BuilderDatabase`, `atomically()` in `lib/hq/builder-db.ts`;
  `MemberTeamView`, `CaptainAssignmentView`, `PublicPersonView`,
  `CaptainLeaderboardView` and their mappers in `lib/hq/view-models.ts`. A
  member response is built from a view model so it cannot carry an operator
  field; `CapabilityGrant`, `AuditEvent` and `Person.removal` are
  operator-only shapes and never reach one.
- **Shell and routes.** `MEMBER_PUBLIC_PATHS`, `isMemberPath`, `safeMemberNext`,
  `inviteLink`, `joinLink`, `parseJoinCode` in `lib/hq/member-routes.ts`;
  `getMemberNav({ capabilities, hasTelegram, hasTeams })` and
  `isNavItemCurrent` in `lib/hq/member-nav.ts`. A new member page is one entry
  in `MEMBER_PUBLIC_PATHS` and, if it needs a menu item, one item in
  `getMemberNav`.
- **Test helpers.** `applyMigrations(pg)` and `pgliteBuilderDatabase(pg)` in
  `tests/hq/helpers/db.ts`.
- **Captain service (phase 4, complete).** `lib/hq/captains.ts`:
  invitations (`createCaptainInvitation`, `readCaptainInvitationByToken`,
  `acceptCaptainInvitation`, `revokeCaptainInvitation`,
  `listCaptainInvitations`), assignments (`assignCaptain`, `unassignCaptain`,
  `clearCaptainAssignments`, `countAssignmentsForCaptain`,
  `countAssignmentsForUsers`, `listAssignments`, `countAssignmentsByCaptain`),
  reads (`leaderboard`, `currentCaptainOfProject`).
- **Reporting service (phase 5, complete).** `lib/hq/reporting.ts` is the one
  module to import; see its module-map row above for the full list and the
  section below for what phase 6 owes it. Everything takes a `BuilderQuery`
  or `BuilderDatabase` it is given, and every member-facing read and write
  goes through `authorizeProjectAction`, `entryAudience` or `canEditEntry`
  rather than a rule of its own.
- **Colosseum integration and deletion (phase 3, complete).** See the two rows
  in the module map above, and the sections below.
- **Telegram bot (phase 7, complete).** `handleTelegramUpdate` in
  `lib/hq/telegram-bot.ts` is the flow; `lib/hq/telegram-bot-store.ts` is the
  durable state, and three of its functions are phase 8's delivery path
  (`deliverableBotChat`, `enqueueBotMessage`, `flushBotMessages`);
  `lib/hq/telegram-bot-api.ts` is the only module that holds the token;
  `telegramMemberActor` in `lib/hq/actor.ts` is the second admitted actor
  origin. See the module-map row and the section at the end of this file.
- **Final period (phase 10, complete).** `lib/hq/submission.ts` is the one
  module to import for submission evidence, the bounded refresh and the
  closing reconciliation; `lib/hq/submission-readiness.ts` is the pure
  checklist and copy; `submissionFocusFor` in `lib/hq/reporting-surface.ts` is
  the one composition every authorized surface renders, carried on
  `TeamReportingPanel.submissionFocus` and `CaptainReportingCard.submissionFocus`.
  `fetchEditionSubmissionWindow` and `submittedOnTime` finally have production
  callers. See the section at the end of this file.
- **Job runner (phase 8, complete).** `lib/hq/jobs.ts` is the one module to
  import: `runDueWork` is one whole pass, and `dueReminders`,
  `prepareReminder`, `expireStaleReminders`, `reconcileReminderDeliveries`,
  `closeDuePeriods`, `purgeReminderDeliveries` and `listReminderDeliveries`
  are its parts. `closePeriod` now has a production caller.
  `lib/hq/github-actions-auth.ts` takes a `ScheduledJob` (`LUMA_SYNC_JOB`,
  `HQ_JOBS_JOB`), so a third scheduled job is a constant rather than a second
  claim policy. A phase that wants scheduled work adds its own audience and
  its own workflow file and calls it from `runDueWork`, rather than adding a
  timer of its own.

### What phase 3 settled, and what a later phase must not undo

1. **`verification` stays, and a successful import writes `'verified'`.** The
   owner removed the verification *step*, not the column: it is the marker
   `loadTeamMembership` (`lib/hq/authz-sql.ts`) and every reader over it uses
   for "is this account a member of this team". Do not drop it, and do not
   introduce a state an import cannot reach. A pre-existing row with
   `verification <> 'verified'` is a legacy claim from before 14 September
   2026; it has no route back to a usable team except an admin deleting it,
   which is correct under the new rules and empty in practice.
2. **There is no review surface.** `reviewBuilderProject`, the verification
   controls, `proof_comment_id`, `proof_author_id` and
   `hq_project_challenges` are gone. Do not re-add a control that implies a
   review step still happens.
3. **The gate is exactly two comparisons**, both read from the response body
   and neither hard coded: `isNetherlands(project.country)` and
   `project.hackathonId === hq_hackathon_onboarding.external_hackathon_id`.
   `gateProject` in `lib/hq/project-import.ts` is the one copy;
   `builder-store.ts#importTeam` re-checks inside its transaction as a last
   line of defence, not as a second rule.
4. **Every failure keeps its own message.** `IMPORT_REFUSAL_MESSAGES` and the
   adapter's own per-code messages are asserted distinct by
   `tests/hq/builder-import-ui.test.ts`. Colosseum's own error text is data
   (`sourceCode`/`sourceMessage`, stored in `source_error_message` for
   operators), never a member-facing message and never markup.
5. **One submission interpretation.**
   `lib/hq/colosseum-snapshot.ts#interpretSubmission` is the only writer of
   `submission_status`, and `DRAFT_SIGNAL_CONFIRMED` is the single switch
   deciding whether a null `submittedAt` may read as Not submitted. It is
   **`true` since 2026-09-14**, when the submitted/unsubmitted pair was
   finally observed live (both readings are in the constant's own comment,
   with the one caveat that they come from different editions).
   `projectCompletion.isComplete` is readiness, is not an input, and — also
   found on 2026-09-14 — is not returned by the public detail endpoint at
   all, so `completion_is_complete` is NULL in practice. Phase 10's
   final-period work builds on this function; it does not add a second
   reading.
6. **The Captain-conflict race is closed by a lock.**
   `checkCaptainConflict` (`lib/hq/captains.ts`) now locks the CRM person
   rows its roster points at, in id order — lock-order step 3b. Phase 3
   stamping `person_id` onto roster rows is what made that check reachable
   and the race real; the decision recorded here is that locking beat
   accepting it, because the state at stake is a stated product invariant.

### Deletion, and what a phase that adds a table owes it

`lib/hq/record-deletion.ts` deletes a team and a person in one transaction
each, audited, with the real counts read before the destructive step. Its
header lists exactly what points at `hq_projects`, `hq_people` and
`hq_crm_persons` as of the current checkout, and **that list is part of the
contract**: a phase that adds a table pointing at any of the three updates it,
decides per table whether a cascade is right, and adds the count to the
impact so the confirmation names what goes. `deleteProject` in
`lib/hq/actions/projects.ts` delegates here, so extending these two functions
covers the Projects board as well.

Phase 5 did this for its four reporting tables: `hq_reporting_eligibility`,
`hq_reporting_entries`, `hq_reporting_entry_revisions` and
`hq_reporting_outcomes` all cascade with the team and are all counted in
`TeamRemovalImpact`, while `hq_reporting_periods` is deliberately untouched
because the periods belong to the edition rather than to any one project. It
left `deletePersonRecord` unchanged on purpose and said so in the header:
nothing in reporting points at a People card or a CRM person, and a person
deletion never deletes the `hq_builder_profiles` account an entry names, so a
person's updates correctly survive their card.

### The fallback asset

Done. `docs/plans/assets/hq-project-fallback.png` (untracked source) was
copied to `public/images/hq/project-fallback.png` and is referenced through
`PROJECT_FALLBACK_IMAGE` in `lib/hq/colosseum-snapshot.ts`.
`components/hq/builder-project-image.tsx` renders it, as a plain `<img>` with
an `onError` fallback and **not** `next/image`: routing a third-party CDN
through `next/image` would mean allow-listing that host in `remotePatterns`
and re-serving arbitrary remote bytes from this application. It is decorative
project imagery, never a fallback for a human avatar. The file is 1.1 MB; a
smaller export is an optional owner follow-up (manual setup 2.7).

### The Colosseum edition: now verified, still operator data

**Verified on 2026-09-14:** the current campaign is external Colosseum id
**7**, slug **`crypto-worlds-fair`**, name "Crypto World's Fair", read from a
live project of that edition whose response carries
`hackathon: { id: 7, name: "Crypto World's Fair", slug: "crypto-worlds-fair" }`.
That edition's project directory is still disabled, so it is absent from
`GET /api/projects/directories` and **Colosseum's own** submission deadline
(`projectSubmissionEndDate`) cannot be read yet; the detail endpoint is what
confirmed the edition. Do not confuse that deadline with **HQ's** hackathon
dates (`hq_hackathons.start_date`/`end_date`, set in Admin), which are what
phase 5's reporting periods run on and which are already in place.
`fetchEditionSubmissionWindow` and `submittedOnTime` have no production
caller today — they exist for phase 10. External id 6 is the finished
**Frontier** edition, slug `frontier`.

**Knowing the value changes nothing about where it lives.** It is still
operator data: the admin types it into Admin under Builder onboarding and it
is stored in `hq_hackathon_onboarding`, never seeded, never a constant, never
an environment variable. The verified value is recorded in
`docs/hq/manual-setup.md` item 2.6 — a document, not code. The `6` that
appears inside HQ is the internal `hq_hackathons.id`, never the external
mapping. **Until the mapping is set, every self-service import is refused
with `edition_not_configured`** — phase 3 does not silently compare against
null.

### Fixtures

`tests/hq/fixtures/colosseum/`: `directories.json`, `listing.json`,
`detail.json`, `errors.json` and a `README.md` recording provenance and which
shapes are assumptions. Every project, roster, handle, display name, avatar
URL and project id in them is invented. Phase 3 extended the tests over these
files rather than the files themselves: `tests/colosseum-api.test.ts`,
`tests/hq/colosseum-snapshot.test.ts` and `tests/hq/builder-import-ui.test.ts`
all validate against them, including `errors.json`'s "directory disabled" and
"unknown edition" bodies, which are the pair the old adapter could not tell
apart. `detail.json`'s `unsubmitted` entry remains a structural assumption,
unverified against a live draft — which is exactly what
`DRAFT_SIGNAL_CONFIRMED` refuses to build a red badge on.

### Building a surface, for the phases that render one

Phases 0 to 5 built services and two thin member pages. Phase 6 is the first
phase whose main output is interface, so the conventions it would otherwise
have to reverse-engineer are written down here.

**A member page** lives under `app/hq/(member)/`, is `export const dynamic =
"force-dynamic"`, and **carries its own gate**: `requireMemberActor(next)`,
plus a capability or authorization check where the route needs one, exactly
as `app/hq/(member)/captain/page.tsx` does. The group layout is **not** the
auth boundary — layouts do not re-render on soft navigation, so it only
provides the nav state — and its own comment says so. The page composes
`<BuilderShell>` itself (`components/hq/builder-shell.tsx`, props
`{ children, wide?, back? }`) and styles with
`components/hq/builder-shell.module.css`, whose classes are exactly `page header nav navList brand account
accountName signOut main wide card row status notice form field actions
button secondary textButton choices choice check code details error success`. Add the
route to `MEMBER_PUBLIC_PATHS` in `lib/hq/member-routes.ts` (the one list,
enforced by `tests/hq/member-routes.test.ts`) and, if it needs a menu item,
one item in `getMemberNav`.

**An operator screen** extends the existing boards rather than adding a
system of its own: `components/hq/projects.tsx`, `people.tsx` and
`builder-admin.tsx`, with `components/hq/builder-admin.module.css` and the
file-local `ActionForm` in `components/hq/builder-admin.tsx` (a form whose
submit runs a Server Action and renders its `ActionResult`; it is not
exported, so a new operator panel either lives in that file or lifts it). Operator data loads
through `lib/hq/queries.ts` or `lib/hq/builder-admin-queries.ts` and every
record action resolves its id through `inHackathon`.

**Every new `"use server"` module under `lib/hq/actions/` must be added to
`ACTION_GATES` in `tests/hq/auth-boundary.test.ts`**, which names the gate
each file is expected to carry; the test fails on an unlisted module.
Operator action modules are additionally scanned by
`tests/hq/operator-imports.test.ts`: they must not reach the public member
auth graph, which is why `assertHackathonMatches` and `isPlaceholderEmail`
live in leaf modules. A member-gated action that would otherwise sit in an
operator-scanned file gets its own module, as `lib/hq/actions/invite.ts` did.

**Copy rules**, from the plan's phase 6 acceptance: no em dashes and no
middots in interface text, and no unnecessary technical terminology. Member
denials are identical whatever the reason (`TEAM_NOT_AVAILABLE`), and a
refusal from a service is shown as the specific, actionable message the
service distinguishes — never collapsed into a generic error, the rule phase
3 established for imports.

### What phase 5 settled, and what phase 6 did with it

Phase 5 built the reporting model and deliberately built **no screen and no
Server Action**: standing rule 1 above ("a stub module is work with no user",
"a stub route handler would be a live endpoint") applies exactly to an action
with no page behind it. Phase 6 added the team, Captain and admin surfaces and
the actions that call the service; phase 7 adds the bot handlers and phase 8
the reminder and closure jobs. The ten points below are the service's own
rules, all still current; the section after this one records what phase 6
settled on top of them.

1. **Dates come from the edition, never from Colosseum.**
   `readReportingSchedule(db, hackathonId)` assembles the campaign window from
   `hq_hackathons.start_date`/`end_date`, the timezone from
   `hq_settings.timezone`, and the final-period start and nudge settings from
   `hq_reporting_config`. Do not add a second copy of any of them.
   Colosseum's own `projectSubmissionEndDate` is a separate external deadline,
   stored as `hq_reporting_config.official_submission_deadline` when an admin
   records one; it is phase 10's input and it never moves HQ's window.
2. **A period's identity is its `sequence`, not its dates.**
   `ensureReportingPeriods` matches stored periods to regenerated ones by
   sequence and **refuses to move or remove any period that already holds an
   entry or an outcome or that has been closed**, returning it as a
   `ReportingPeriodConflict` instead. `previewReportingPeriods` is the same
   computation with no writes, and it is what Admin's Weekly reporting panel
   shows before a live date change (the plan's "show affected periods before
   an admin changes a live schedule"); applying is a separate press.
3. **Ends are exclusive internally, inclusive in what you display.** Every
   period carries both: `startDate`/`endDate` for the screen,
   `startsAt`/`endsAt` (exclusive) for every comparison. Never print
   `endsAt`'s date.
4. **Reporting is keyed on `hq_projects`, not `hq_project_onboarding`.** This
   is the deliberate answer to `/hq/captain`'s reduced card: a project an
   admin created directly in the CRM has the same eligibility row, periods and
   status as an imported team, and `ReportingEligibility` and
   `ProjectReportingStatus` both carry `projectName` and `imported`. Build the
   reporting parts of a Captain or admin card from the status shape and it
   needs no `BuilderTeam`; only roster, lead and Colosseum link still require
   one. Phase 6's Captain page does exactly that, so the reduced card is gone.
5. **The audience is applied in SQL, so do not filter in the browser.**
   `readAuthorizedUpdates` never returns a sensitive body, a sensitive entry's
   existence, or a voided entry to a member who is not its author, and a
   denial is an empty page rather than an error. `readRevisionHistory` is
   operators only and returns an empty list to anyone else. A status response
   carries no entry body at all. Do not add a "hidden note" count or preview:
   the team sees Updated, and nothing more.
6. **Sensitive is authorized per project, by reading the decision.**
   `authorizeProjectAction`'s `via === "captain"` means "the current Captain
   and not a team member", because membership is checked first. A Captain
   posting on their own team comes back `via: "member"` and cannot use the
   global capability to hide an update from their teammates. Do not re-derive
   this rule in a component. The same decision settles completion (added
   18 September 2026 with the Captains' Den redesign: "Captain notes never
   change a team's update status"): `createUpdate` stores
   `hq_reporting_entries.counts_toward_completion` as `via === "member"`, the
   two completion queries (`reportingStatus`'s tallies and `closePeriod`'s
   first entry) read only rows where it is true, and `completesPeriod` is
   false for the rest. A note from the assigned Captain or from an operator,
   shared or sensitive, is therefore recorded beside the week and never marks
   it Updated; only a team member's update does. The bot inherits it through
   the shared service. `tests/hq/reporting.test.ts` ("what completes a week,
   per author and per visibility") holds the rule at save and at closure.
7. **Drafts are bound to their period.** Pass `expectedPeriodId` from whatever
   the composer was opened against; a save that crossed midnight comes back
   `{ ok: false, reason: "period_changed", currentPeriod }` and the caller must
   ask before moving the text into the new week. An edit conflict comes back
   `{ ok: false, reason: "conflict", current }` and the unsaved text must be
   preserved, not discarded. Phase 6's screens do both; a phase 7 handler owes
   them the same.
8. **A period's recorded outcome is history.** `closePeriod` is idempotent and
   never rewrites; a late entry is marked `late`, completes nothing and leaves
   the missed outcome exactly as recorded; `correctOutcome` writes
   `corrected_completed` beside the original with a mandatory reason and an
   audit event. Read the effective answer as
   `COALESCE(corrected_completed, completed)` — `ProjectReportingStatus`
   already does.
9. **`reportingStatus` is the dashboard read.** Seven queries for a whole
   edition whatever the project count, with `projectIds` to narrow and
   `includeHistory` for per-period detail. Never loop it per project, and
   never build completion from `readAuthorizedUpdates`.
10. **A phase that adds a table pointing at a project or a person extends
    `lib/hq/record-deletion.ts`.** Phase 5 added its four to `deleteTeamRecord`
    (all cascade; `hq_reporting_periods` deliberately untouched, since the
    periods belong to the edition) and left `deletePersonRecord` unchanged on
    purpose: nothing in reporting points at `hq_people` or `hq_crm_persons`,
    and a person deletion never deletes the account an entry names. That
    decision is written in the module header with a test behind it.

### What phase 6 settled, and what phase 7 and later inherit

Phase 6 built the team, Captain and admin reporting surfaces and the Server
Actions behind them. It added no table.

1. **The authorization decisions are session-free, and reporting depends on
   that.** `lib/hq/authz-decisions.ts` holds every decision; `lib/hq/authz.ts`
   re-exports all of them and keeps `requireOperator()`, the one function that
   reads a session. `lib/hq/reporting.ts` therefore reaches neither `./actor`
   nor `./member-auth`, which is what lets one reporting service serve both a
   member action and an operator one instead of being copied. Restoring that
   edge breaks every operator action module at once
   (`tests/hq/operator-imports.test.ts`).
2. **Two service refusals have screen answers, and a phase 7 handler owes them
   the same.** `period_changed` carries the week that is open now and writes
   nothing; the caller asks before moving the text. `conflict` carries the
   entry as it is saved now; the caller keeps the unsaved text beside it. A bot
   handler that collapses either into "something went wrong" loses the
   person's words, which is the case the plan names.
3. **Copy lives in `lib/hq/reporting-view.ts`.** Pure, client-safe, and scanned
   by `tests/hq/reporting-view.test.ts` for em dashes and middots along with
   the three reporting components. A phase that writes reporting copy puts it
   there rather than inline, or the scan stops covering it.
4. **A card's reporting half is built from `ProjectReportingStatus`.** It
   carries `projectName` and `imported`, so a CRM-only project gets the same
   week, status and composer as an imported team; only the Colosseum detail
   differs. There is no reduced reporting row, and reintroducing one would
   undo the phase 5 ruling.
5. **The two contacts are opt-in and self-set.**
   `hq_project_onboarding.team_contact` (the team lead sets it, the assigned
   Captain and admins read it) and `hq_builder_profiles.captain_contact` (the
   Captain sets it, their teams and admins read it). Setting one is the
   approval; nothing derives either from a login, a profile address or
   Colosseum, and `MemberTeamView.captain.contact` is now populated from the
   second. The Captain column shares a name, and nothing else, with
   `hq_partners.captain_contact`, which is a partner organisation's contact
   person.
6. **The prompt's dismissal is per browser, keyed by project and period.** Not
   a table: it has no audience and no history, the outstanding action stays
   either way, and completion is what ends the prompt for good. It renders on
   the server too, because its hydration snapshot answers "not dismissed".
7. **A live date change is previewed before it is applied.** Admin shows
   `previewReportingPeriods`'s plan and every week it must not move, with the
   reason and the counts; applying is a separate press. `saveReportingConfiguration`
   deliberately does not regenerate the periods, for the same reason.
8. **`closePeriod` had no production caller when phase 6 shipped.** It has
   one since phase 8: `closeDuePeriods` in `lib/hq/jobs.ts`, on the scheduled
   pass. There is still no admin close button, deliberately.
   `reportingStatus` computes the same answer live for a week that has ended
   and not been closed, so every screen was already honest about a missed week
   before the job existed, and still is between two runs.
9. **`nudge_at` is computed and stored per period.** Phase 6 sent nothing
   with it; since phase 8 it is what `dueReminders` reads to decide a
   reminder is due, and the weekday and time stay editable in Admin rather
   than only in the database.
10. **The member pages have not been reached through a real sign-in**, because
    `BETTER_AUTH_URL`/`BETTER_AUTH_SECRET` are still the owner's outstanding
    setup item. Their components were checked in a browser against real rows
    at desktop and phone width, and `tests/hq/reporting-team-page.test.ts`
    renders the real page. What is unverified is the sign-in path into them.

### What phase 7 settled, and what phase 8 and later inherit

Phase 7 built the deterministic Telegram bot: four tables, one column, five
modules and one route. It added no reporting rule, no audit kind and no
permission.

1. **The bot owns nothing.** Every write goes through `createUpdate` /
   `editUpdate` in `lib/hq/reporting.ts` with `source: "telegram"`, which is
   the only thing that differs from an HQ save. Every read goes through
   `captainReportingBoard`, `readAuthorizedUpdates` or `readOwnUpdates`.
   `tests/hq/telegram-bot.test.ts` asserts the consequences rather than the
   intention: a bot save writes one revision and, being a Captain's note,
   leaves the team's week `Not updated`, and a sensitive note reaches the team
   as nothing at all.
2. **A verified Telegram identity is the second admitted actor origin.**
   `telegramMemberActor(telegramUserId, db?)` in `lib/hq/actor.ts` builds the
   same `MemberActor` a session would, from `hq_auth_telegram_identity` read
   on every update. It grants nothing on its own. The plan's rule holds
   exactly: an actor id comes from a validated session or a verified Telegram
   identity, never from a payload. Unlinking Telegram deletes that row, so the
   next message resolves to null with nothing else to revoke.
3. **Identity, messaging permission and Captain access are three separate
   facts, checked in that order on every update.** Connected but not
   permitted gets the Turn on bot messages button and no project data.
   Permitted but not a Captain gets a sentence about how to get access and no
   project data. Refusing bot messages changes nothing about website access,
   and `tests/hq/telegram-bot.test.ts` asserts that through
   `authorizeProjectAction` rather than through a screen.
4. **A callback identifier is an opaque server-side reference, and a button
   that touches a draft is pinned to that draft.** `hq_telegram_actions` holds
   the meaning; `callback_data` holds a uuid. Since phase 8 it also holds
   `hackathon_id`, the edition the press is scoped to: the bot reads one
   current edition for everything, which is right for somebody who opened the
   menu and wrong for a button that arrived in a notification about a
   different edition. Every button minted during a press inherits the edition
   of the button that was pressed, so paging and picking a team stay inside
   it. It grants nothing on its own, because the board it opens is still only
   this account's own current assignments there. A reference is bound to one
   account and one chat and expires. A button that touches a draft
   additionally records `draft_id` and `draft_revision`, and `boundDraft`
   refuses unless both still match: `hq_telegram_drafts.id` changes when a new
   compose replaces the old one, and `revision` increments on every change.
   Without that pinning, Save meant "whatever draft exists now", so a Save
   pressed on a replaced preview saved a different team's text and two
   previews of one draft both saved. An external review on 15 September 2026
   reproduced all three.
5. **Three deduplications, because there are three duplicates.**
   `hq_telegram_updates` keyed on Telegram's own `update_id` catches a
   redelivered webhook; `consumeBotAction` catches a second press of one
   button; `claimBotDraft` catches two different buttons that mean the same
   logical save. The last two run inside the saving transaction, which is what
   makes them roll back with it.
6. **A receipt distinguishes finished from interrupted, and an interrupted
   update is retried.** `claimTelegramUpdate` takes a LEASE. `done` is
   terminal; a live lease means another invocation has it; `failed`, or a
   lease that has expired, means the previous attempt died and the work must
   be picked up again, bounded by `MAX_UPDATE_ATTEMPTS`. Treating a crashed
   attempt as a completed duplicate is what silently lost an update to one
   transient database error. Retrying is only safe because of rule 7.
7. **A save is one transaction.** `consumeBotAction`, `claimBotDraft`,
   `createUpdate` / `editUpdate`, the post-write `reportingStatus` read and
   `enqueueBotMessage` all commit together, through the handle
   `db.transaction` hands the callback. Nothing survives alone: not an entry
   with no confirmation, not a consumed button with no entry, not a deleted
   draft with no save. A refusal from the reporting service throws
   `SaveAborted`, which rolls the whole thing back, which is precisely what
   lets `period_changed` and `conflict` keep the person's words on screen and
   still offer a working follow-up button.
8. **The outgoing queue is for messages that carry news, and it never carries
   an update body.** The save confirmation is enqueued inside the saving
   transaction; menus and previews are sent directly, because a failed send is
   answered by pressing the button again. That split is also the privacy rule,
   and a test asserts the note body is absent from `hq_telegram_outgoing`.
   A direct send that fails RETRYABLY does not acknowledge the update: the
   receipt is marked `failed` and the webhook answers 502, so Telegram
   redelivers and the reply is rebuilt from state nothing destroyed.
9. **A queued message is re-validated immediately before it is sent.**
   `flushBotMessages` checks the Telegram identity, the messaging consent, the
   chat id, that the chat was opened BY the identity connected now, and, when
   the row names a project, `authorizeProjectAction`. A message queued while
   somebody was a Captain with messaging on is not delivered after they turned
   it off, unlinked, relinked to a different Telegram account, moved chat or
   lost the assignment; the row is recorded `skipped` with the reason.
   The identity half of that is phase 8's correction: matching the chat id
   alone said where a message would go, never whose chat it was, and
   disconnecting Telegram left the chat on the row for a different account to
   inherit. `hq_telegram_bot_consent.chat_bound_telegram_user_id` is what
   makes the invariant checkable; `bindBotChat` is its only writer and both
   consent paths clear it when the identity changes. Phase 8's reminder needs
   more than this and adds a hook rather than a copy: see its own section.
10. **Rows are claimed before they are sent.** One atomic update takes a
   bounded batch with an owner and an expiry (`FOR UPDATE SKIP LOCKED`), and
   only that owner may complete them, so two drains divide the queue instead
   of both sending the same row. A claim that expires releases the row. This
   prevents the ordinary concurrent-worker duplicate; it does not promise
   exactly-once delivery, because a claim expiring after Telegram accepted a
   message is a genuine unknown.
11. **A timeout is uncertain, not failed.** `flushBotMessages` leaves a
   timed-out send `queued` with its attempt counted and a backoff in
   `next_attempt_at`, honours Telegram's own `retry_after`, stops permanently
   on a blocked bot (`skipped`, with Telegram's words kept for an operator),
   and gives up after `MAX_SEND_ATTEMPTS`.
12. **Splitting belongs to the view, never to the transport.**
   `packMessages` builds whole, correctly escaped messages within
   `TELEGRAM_TEXT_LIMIT`, chunking a body BEFORE escaping so a cut can never
   fall inside an entity or a surrogate pair, and putting the fixed parts that
   follow a body into a message of their own so the audience line survives.
   The transport refuses an over-length message (`message_too_long`) rather
   than slicing HTML, which used to cut `&amp;` in half and drop a closing
   `</blockquote>`. A long note therefore arrives as several replies, with the
   keyboard on the last.
13. **Copy lives in `lib/hq/telegram-bot-view.ts` and reuses the reporting
   words.** A week's dates, the two status words, each audience and each
   service refusal all come from `reporting-view.ts`, so the bot and the
   screens cannot describe the same week differently.
   `tests/hq/telegram-bot-view.test.ts` runs the same em dash and middot scan.
14. **Escaping is total.** Every message goes out with `parse_mode: "HTML"`
   and every interpolated value passes through `escapeHtml` first, including
   project names from Colosseum, team contacts and update bodies.
15. **My notes opens a note, it does not summarise one.** The list shows a
   snippet and a Read button per note; `note.open` renders the whole body
   through `packMessages`, and Rewrite appears only when the project is still
   this Captain's and `readAuthorizedUpdates` still says the entry is theirs
   to change. Paged on `readOwnUpdates`' own keyset cursor, carried on the
   action row, not a capped set re-read on every press. For a team the account
   no longer holds this is the only route to their own note, so a 220
   character summary made everything after it unreachable.
16. **The webhook is its own boundary.** A dedicated secret header compared in
    constant time, a body read in BYTES and abandoned mid-stream past the cap,
    a validated schema, and no cookie or session of either kind. An
    unconfigured deployment answers 503 rather than opening a way in, the same
    honest unavailability `/api/auth/*` gives.
    `tests/hq/auth-boundary.test.ts` scans for all of it.
17. **Phase 7 added no pointer at `hq_projects`.** `hq_telegram_drafts` and
    `hq_telegram_actions` carry a plain `project_id` uuid with no foreign key,
    for the reasons written in `lib/hq/record-deletion.ts`'s header and in
    `scripts/hq/builder-schema.sql`. A phase that adds a table which is a
    record rather than chat state still owes the deletion functions a row.
18. **Nothing in the bot is scheduled.** It only ever reacts to an inbound
    update, and that is still true. What changed in phase 8 is that something
    else calls into it on a timer: `runDueWork` enqueues a reminder, drains
    the queue through `flushBotMessages` and calls `purgeExpiredBotState`,
    which sweeps only receipts recorded `done`, so a retry still waiting for
    Telegram is never swept out from under itself.

### What phase 8 settled, and what phase 10 and later inherit

Phase 8 built the job runner: one table, one module, one route, one workflow,
one operator action and one admin panel. It added no reporting rule, no audit
kind, no permission and no second definition of a week.

1. **Nothing schedules itself.** `dueReminders` answers "what is due AT THIS
   INSTANT" from the stored periods, and a period's `nudge_at` opens a
   WINDOW (`nudge_at <= now < ends_at`) rather than naming a moment. That is
   what makes the plan's "do not rely on ... one exact cron invocation" true
   in practice: the workflow runs every half hour, a run that never happens
   catches up later the same day, and a run that happens ten times finds
   nothing due nine of them. A phase that wants scheduled work of its own
   expresses it the same way, as a query over stored state, and calls it from
   `runDueWork`.
2. **One reminder per Captain, per edition, per period, per type, enforced by
   an index and not by a check.** `hq_reminder_deliveries` is unique on those
   four columns and `prepareReminder`'s first statement is
   `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so two passes running over
   each other both attempt it and only one gets a row back. The queued
   message carries the same four values as its `dedupe_key`, so even a bug
   past the first lock cannot produce a second message.
3. **The scan is a hint, and so is the enqueue. The dispatch is the truth.**
   `outstandingForCaptain` in `lib/hq/reminder-dispatch.ts` is the one
   definition of what a Captain still owes, and it runs TWICE: once inside
   `prepareReminder`'s transaction, and again inside `deliverable()`
   immediately before every single send attempt, where the message BODY is
   rebuilt from its answer. The review of 15 September 2026 is why: checks
   made before the enqueue are not checks made before the send, and the gap
   between the two is ordinary rather than a race (a deployment with no bot
   yet queues reminders and delivers none; a retryable failure backs off for
   half an hour; the bot's webhook drains the same queue on its own
   schedule). Six deliveries were reproduced that were wrong by the time they
   left. Never build a notification from what a scan returned, and never
   send a body that was composed before the last thing that could invalidate
   it.
4. **A decision is recorded even when nothing is sent.** No Telegram
   identity, messaging turned off, no chat opened, capability revoked,
   nothing outstanding: each is a row with its own reason, shown in Admin
   under Weekly reporting. That is the plan's "record a skipped delivery
   reason and show it in HQ", and it is also why the table exists rather than
   a query over `hq_telegram_outgoing`, which only ever holds messages
   somebody decided to send.
5. **None of it is ever a weekly status.** The weekly vocabulary is two
   words, Updated and Not updated. A blocked bot, a rate limit and an
   unreachable Captain are facts about a message and are rendered as such;
   `tests/hq/jobs.test.ts` asserts that a permanently refused reminder leaves
   both teams' weeks exactly as they were.
6. **Delivery is still phase 7's, with one hook.** `flushBotMessages` claims
   a bounded batch, re-validates the recipient immediately before every send,
   honours Telegram's `retry_after`, treats a timeout as uncertain and stops
   permanently on a blocked bot. Phase 8 added two things to it and no second
   retry policy: `deliverable()` now recognises the reminder `kind` and
   re-decides the whole message through `./reminder-dispatch`, and the clock
   is read PER MESSAGE rather than once when the pass began. The decision
   lives in the send path rather than in the job on purpose: a check the job
   makes protects only the job's own drain, and there is more than one
   consumer of that queue. `reconcileReminderDeliveries` copies the outcome
   onto the reminder row.
7. **There is no time-to-live, deliberately.** An earlier round had
   `REMINDER_MAX_AGE_MS`, on the reasoning that a body nobody could
   re-validate should not be delivered once it was old. Now that the body is
   rebuilt at dispatch, age no longer makes a reminder wrong, and dropping a
   three-hour-old one would discard a message that is still accurate and
   still wanted. What remains is `expireEndedReminders`, which resolves a
   queued reminder whose week is over WITHOUT waiting for somebody to try to
   send it: a deployment with no bot never drains the queue, and "waiting to
   send" for a week that ended is a worse thing for an admin to read than
   "not sent, the week ended". It is housekeeping, not the check.
8. **`created_at` on a reminder is written from the JOB's clock, not the
   database's.** It is the left-hand side of the staleness comparison whose
   right-hand side is the job's own instant; writing `now()` would compare two
   readings of two different clocks. Any later table a job writes and then
   compares against its own `atMs` owes the same treatment.
9. **Closure is a job, and its answer must not depend on when it ran.**
   `closeDuePeriods` closes every period whose exclusive end has passed,
   oldest first, through `closePeriod`. Because that job is explicitly allowed
   to be late, `closePeriod` resolves the responsible Captain from the
   ASSIGNMENT HISTORY at the period's own boundary (assigned before the
   exclusive end, not unassigned before it) rather than from whoever holds the
   project when it runs. Reading the current assignment meant a reassignment
   in the gap handed the previous week to a Captain who never held the team
   during it, which the review reproduced. Archived editions are still closed:
   archiving stops reminders, a week that ended is history either way.
10. **The job endpoint is its own boundary, like the webhook.** Its own OIDC
    audience (`stnl-hq-jobs`) and its own workflow file (`hq-jobs.yml`), both
    checked; no cookie, no operator session, no member session, and no stored
    secret of any kind. `tests/hq/auth-boundary.test.ts` scans for all of it,
    including that the workflow references no `secrets.`. The admin Run now
    button is the second, session-authenticated door to the same function, and
    it is deliberately NOT a per-Captain resend: re-queueing a refused message
    by hand is how "avoid aggressive retries that spam Captains" gets broken.
11. **Retention is documented in constants and swept on every pass.**
    `purgeExpiredBotState` (phase 7's drafts, actions, finished receipts and
    old deliveries) and `purgeReminderDeliveries` (`REMINDER_RETENTION_MS`,
    180 days, and only for weeks that are closed). Reporting outcomes and
    audit history are separate and are never swept.
12. **`hq_reminder_deliveries` names no project.** It counts them.
    `lib/hq/record-deletion.ts`'s header says why: a reminder is a statement
    about a Captain's week, and a deleted team's name must not outlive the
    team inside a history table. That is also why phase 8 needed no change to
    either deletion function, which the contract above requires a phase adding
    a table to decide explicitly rather than by omission.
13. **`CAPTAIN_PATH` lives in `lib/hq/member-routes.ts`.** The bot's Open HQ
    buttons, the reminder's Open HQ button and `MEMBER_PUBLIC_PATHS` all read
    it from there; there is no second literal.
14. **A delivery that got no answer is not a failure, and the record says so.**
    The transport already told a timeout from a refusal; the row threw the
    distinction away, because `last_error` stored Telegram's `detail` and a
    timeout has none. It now stores `"<code>: <detail>"`, and
    `ReminderDeliveryView.deliveryUncertain` is derived from the code, kept
    separate from `state` and preserved through exhaustion: "could not be
    sent" is a claim, and it is the wrong claim for a message that may well
    have arrived. `reconcileReminderDeliveries` also copies attempts, the
    error and `next_attempt_at` while a message is STILL retrying, so an
    admin can tell "nobody has tried yet" from "Telegram asked us to wait".
15. **One pass has a sending budget, not just a batch ceiling.** The endpoint
    declares `maxDuration = 60` and every send carries its own 8 second
    transport timeout, so the batch ceiling alone allowed a pass that could
    not finish. `SEND_BUDGET_MS` stops it early with work left rather than
    being killed halfway; the queue is drained by the next pass, and a
    claimed row is released when its claim expires either way.
16. **A manual run reports partial progress honestly.** A pass is a sequence
    of separately committed steps, so a failure can leave weeks closed and
    messages sent. The action says that and says retrying is safe, rather
    than claiming nothing happened.

### What phase 10 settled, and what phase 11 inherits

Phase 10 built the final, submission-focused period: two modules, one
component, one table, five columns, two operator actions and two job steps.
It added no audit kind, no permission, no reminder type and no second
definition of a week.

1. **The checklist cannot become a submission, structurally.**
   `lib/hq/submission-readiness.ts` is pure, has no database handle and
   produces no submission state at all; `interpretSubmission` in
   `lib/hq/colosseum-snapshot.ts` is still the only writer of
   `submission_status`, reached through `refreshColosseumTeam`, and phase 10
   only ever reads the column back. A complete required checklist leaves the
   period incomplete, and `SUBMISSION_COPY.readinessNotSubmission` says so on
   the screen. Do not add a second reading, and do not let a checklist count
   toward completion.
2. **Requirements are operator data, and Unknown is a real answer.** Colosseum
   publishes no per-field requirement HQ can read: `projectCompletion` is
   owner-authenticated and absent from the public detail endpoint, which phase
   3 recorded. So `hq_reporting_config.required_materials` and
   `optional_materials` are what an admin ticked, anything in neither is
   `unknown`, and nothing is required by default. Never hard-code a material
   as mandatory; that is the plan's own instruction and the reason there are
   three requirement values rather than a boolean.
3. **An item is judged on its own field.** `submissionChecklist` marks a
   material present only when ITS OWN link is set, and names the other
   materials sharing a URL rather than counting one deck twice. "Do not mark
   an item complete merely because an unrelated URL exists" is a rule about
   this function.
4. **The deadline has provenance.** `official_submission_deadline` is one
   column with `official_deadline_source` beside it: an admin typed it, or HQ
   read it from the edition's own listing envelope through
   `fetchEditionSubmissionWindow`, which phase 10 gave its first production
   caller. A failed read stamps `official_deadline_checked_at` and leaves the
   value alone, so "we asked and the directory is closed" is distinguishable
   from "nobody has asked". The comparison itself is unchanged: phase 5's
   `submissionSatisfies` uses the official deadline when there is one and the
   period's own exclusive end otherwise.
5. **The refresh is a query over stored state, like every other scheduled
   thing here.** `dueSubmissionRefreshes` answers "which snapshots are stale at
   this instant" from `submission_refresh_minutes`, an open submission period,
   an unarchived edition and an unpaused project in reporting. It is off until
   an admin sets an interval, floored at 15 minutes, capped at five projects
   and 12 seconds a pass. A phase that wants its own background source work
   expresses it the same way and calls it from `runDueWork`; it does not add a
   timer or a browser poll.
6. **The reconciliation is a catch-up, not a step of the closure.**
   `openSubmissionReconciliations` inserts from the closed submission period's
   own stored OUTCOMES, so it does not matter who closed the period or when, and
   a pass that died between closing a week and opening its rows is repaired by
   the next one. An earlier round hung it off `closePeriod`'s return value,
   which `closeDuePeriods` never revisits for an already-closed period: a
   single interrupted pass would have left a closed final period with nothing
   tracking its unverified submissions, forever.
7. **Three answers, never two.** `hq_submission_reconciliations.state` is
   `pending` until evidence arrives, and `submission_status` is NULL while it
   is, deliberately not `'not_checked'`: "we never got an answer" and
   "Colosseum answered, but supplied no interpretable evidence" are different
   statements; both remain pending until a confirmed signal arrives. An outage increments `attempts`, records HQ's own error code
   and claims nothing. Nothing in this phase ever turns an unreachable source
   into a failure to submit.
8. **Late discovery is not late submission.** Evidence is judged against the
   deadline recorded ON THE RECONCILIATION ROW when it opens, not against
   when it was discovered and not against a deadline an admin has since
   edited. An on-time submission for a week recorded as missed goes through
   `correctOutcome`; a submission after the deadline is recorded, marked
   `on_time: false`, and corrects nothing.
9. **`correctOutcome` now takes a job actor.** The plan's audited historical
   correction has no operator behind it, so `operatorId` may be null and the
   event is recorded as the `system` actor through the existing `auditActor`.
   A member actor is still refused. No new audit kind was needed:
   `reporting.outcome_corrected` already meant this.
10. **`outcome_corrected` on the row is the idempotence guard**, beside
    `correctOutcome`'s own `unchanged` refusal. A second reconciliation pass
    over a resolved row does nothing, and a week corrected once is never
    corrected twice.
11. **One composition serves every audience.** `submissionFocusFor` in
    `lib/hq/reporting-surface.ts` builds the view once per edition, and the
    team page and Captain card both read it. The admin panel reads the same
    stored submission evidence through `loadProjectReporting`. A Captain and their team can therefore never read a
    different submission state off two screens, and a test asserts the two are
    equal. `completedBySubmission` is derived from the project's OWN
    submission rather than from the period's `basis`, for the same reason
    `TeamPeriodView` omits `basis`: `basis: "entry"` on a week a team sees no
    entries for would tell them a Captain wrote something they may not read.
12. **The weekly vocabulary is untouched.** Submitted/Not submitted and
    Updated/Not updated stay separate words on separate lines everywhere,
    including in the admin panel. A reconciliation is never a weekly status,
    exactly as a reminder delivery never was.
13. **Copy lives in `submission-readiness.ts`, and the scan follows it.**
    `tests/hq/reporting-view.test.ts` now scans that module and
    `components/hq/submission-focus.tsx` for em dashes and middots along with
    the three reporting components. The contract's rule is that reporting copy
    stays inside that scan; a phase that adds a fourth copy module adds it to
    the same list rather than inlining strings.
14. **Phase 10 added one pointer at `hq_projects`, and said so.**
    `hq_submission_reconciliations` cascades from the project and from the
    period, which `lib/hq/record-deletion.ts`'s header records, together with
    why it is not counted in the deletion confirmation: what it holds is
    evidence about the recorded week beside it, and the week is already
    counted.

## Integrated review, 15 September 2026

These current rules supplement the phase handoffs above. The review and remaining
live checks are summarized in `docs/hq/integrated-review.md`; owner steps are in
`docs/hq/manual-setup.md`.

- Unchanged account reads take a read-only synchronization fast path. Actual
  changes and identity repair still use transactions.
- Telegram identity requires its matching live Better Auth provider account.
  `telegram-identity-sql.ts` shares the predicate between login, bot access and
  delivery; interrupted unlink cleanup cannot preserve privilege.
- Captain invitation redemption and manual grants serialize on the recipient
  profile as well as the invitation. Roster claiming never transfers a CRM
  identity belonging to another account.
- Updated 16 September: joining refreshes Colosseum before offering or claiming
  an available teammate. If the source cannot be read, the person can retry.
  The source must match the stored external project and edition;
  `source_attempted_at` tracks failed attempts as well as successes.
- Pending/rejected import compatibility screens and `BuilderStore.ownClaim` are
  removed. Imports are immediately verified under the approved import gate.
- Reporting entries use a single timestamp for the period decision and saved
  submission instant. A future period cannot be completed early. Member and
  operator screens support explicit late entries; operator create/edit use the
  same reporting service as members and the bot.
- A draft retains its opened period and edit version through page refreshes.
  Selecting another period or accepting a conflict is explicit. Refreshed lists
  must remove newly unreadable or voided content instead of retaining stale bodies.
- Voiding recalculates an open period. A closed outcome is preserved until an
  explicit admin correction with a reason; history is not silently rewritten.
- Captain first-page update reads are batched with per-project limits and live
  assignment/audience checks. Submission panels reuse loaded reporting status.
- Outbox sends claim one message at a time, recheck delivery permissions, and
  reserve time for each transport request. Job stages share one invocation
  deadline. Active claims, retry timing and final-attempt crash recovery retain
  an honest distinction between confirmed and uncertain delivery.
- Bot drafts, notes and reminder controls remain scoped to their edition.
  Webhook completion is fenced to its processing attempt. Preview retries recover
  controls; author-note lookup is a bounded query, not a scan of prior pages.
- Submission reconciliation captures its cutoff when the pending record opens
  after closure. Unknown evidence remains pending. A failure still advances the
  source-attempt clock so other projects can be checked.
- Raw snapshot backfills accept only ordinary HTTP(S) links without credentials,
  controls or backslashes. Invalid legacy JSON shapes and out-of-range edition
  IDs cannot abort a migration rerun.
- The local project fallback uses `next/image`; remote project images remain
  direct browser requests. The operator reporting panel loads only when opened.
  Next.js is patched to 16.3.5 and Vitest to 4.1.11; audit fixes are locked.

People deletion still preserves the public sign-in account. A subsequent login
may create a fresh People card. HQ roster membership persists when a source roster
changes; an upstream removal alone never revokes a verified HQ relationship.
