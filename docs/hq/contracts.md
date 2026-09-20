# HQ module contracts

Current implementation boundaries and behavior to preserve when changing HQ.
Code and executable tests define the implemented API; this map records the
security, privacy, data and product decisions behind it. Deployment configuration
and live verification belong in [manual setup](manual-setup.md), not this map.
The [original contract and handoff record](archive/contracts-2026-09-20.md)
and [implementation history](archive/implementation-log-2026-09-20.md) are
historical references, not current implementation instructions.

## Module map

Paths in this table are relative to `lib/hq/`, unless stated otherwise.

| Boundary | Files and entry points | Responsibility |
|---|---|---|
| Runtime database | `db.ts`: `getPool`, `getDatabase`, `getSql`; `builder-db.ts`: `builderDatabase`, `atomically` | One lazy `pg.Pool` for runtime SQL, service transactions and Better Auth. |
| Operator identity | `auth.ts`, `session.ts`, `actions/auth.ts` | Operator credentials and sessions, separate from public accounts. |
| Member identity | `member-auth.ts`, `identity.ts`, `telegram-provider.ts`, `telegram-identity-plugin.ts`, `telegram-identity-sql.ts` | Verified email and Telegram sign-in, linking and live identity checks. |
| Actor and authorization | `actor.ts`, `authz.ts`, `authz-decisions.ts`, `authz-sql.ts`, `member-teams.ts` | Validated actors, current resource access and audience decisions. |
| Grants and CRM identity | `capabilities.ts`, `crm-identity.ts`, `audit.ts`, `audit-sql.ts` | Account capabilities, stable CRM people, explicit corrections and metadata audit. |
| Member data | `builder-store.ts`, `builder-types.ts`, `view-models.ts` | Profiles, ownership, teams, claiming, invitations and member-safe DTOs. |
| Operator reads | `queries.ts`, `builder-admin-queries.ts`, `types.ts` | Edition-scoped boards and their operator-only shapes. |
| Import and source | `project-import.ts`, `colosseum-snapshot.ts`; `lib/colosseum-api.ts`, `lib/colosseum-schema.ts` | Fixed upstream requests, validated snapshots, one import gate and submission interpretation. |
| Captain service | `captains.ts`, `invite-exchange.ts`, `invite-continuation.ts` | Invitations, redemption, assignment history and leaderboard reads. |
| Reporting API | `reporting.ts` | Stable public exports used by actions, dashboards and Telegram. |
| Reporting internals | `reporting/entries.ts`, `reporting/status.ts`, `reporting/outcomes.ts`, `reporting/shared.ts` | Entry authorization and revisions, grouped status, closure/correction and small internal helpers. |
| Schedule and eligibility | `reporting-enrolment.ts`, `reporting-periods.ts`, `reporting-body.ts` | Transaction-safe enrolment, period generation and shared body limits. Re-exported through `reporting.ts`. |
| Reporting presentation | `reporting-surface.ts`, `reporting-contacts.ts`, `reporting-view.ts` | Authorized member composition, contact reads and pure presentation rules. |
| Final submission | `submission.ts`, `submission-readiness.ts` | Bounded source refresh, checklist presentation and historical reconciliation. |
| Telegram | `telegram-bot.ts`, `telegram-bot-store.ts`, `telegram-bot-api.ts`, `telegram-bot-view.ts`, `telegram-webhook.ts` | Deterministic commands, durable drafts/outbox, transport and webhook boundary. |
| Scheduled work | `jobs.ts`, `reminder-dispatch.ts`, `github-actions-auth.ts` | Due work, current reminder decisions, closures, retention and workflow identity. |
| Record removal | `record-deletion.ts` | Transactional, audited project/People deletion with impact counts. |
| Routes and cache | `member-routes.ts`, `revalidation.ts` | One member route policy and refresh scopes including dependent views. |

## Data and transaction rules

- Runtime consumers share the pool owned by `db.ts`; `builder-db.ts` preserves
  service-facing type names rather than owning a second connection pool.
  `getSql()` retains parameterized templates and atomic statement batches.
  `getDatabase().transaction(work)` and `BuilderDatabase.transaction(work)`
  provide one connection for read-then-write decisions.
- `atomically` reuses an existing transaction handle. Services accepting
  `BuilderQuery`/`BuilderDatabase` write through that handle; a nested service
  must not escape to another connection. The write, related audit event and
  any transactional queue record succeed or roll back together.
- Server-only domain modules use `server-only`; pure SQL builders, route
  helpers and presentation modules remain importable without server state.
  Database transport is also used by CLI scripts and stays compatible with them.
- Use grouped reads for boards. `getDashboardProjects` returns the small
  dashboard projection; full project notes/rosters belong to `getProjects`.
  `reportingStatus` reads a whole edition in a fixed number of queries; do not
  call it once per project. Captain first pages use per-project limits in one
  batch. `teamsByIds` hydrates the authorized projects without per-row reads.
- Refresh the views that depend on a mutation through `refreshHq(scope)`.
  Edition/catalog changes also invalidate the layout with the edition picker.
  Do not cache account authorization or assume a previous render still grants access.

## Identity and authorization

- Operator sessions (`hq_users`) and public member accounts are separate.
  A public role, tier, tag, Captain grant or invitation never creates operator
  access. Operator actions call `requireUser` before constructing service actors.
- Actor ids come from a validated operator/member session or a verified
  Telegram identity; job actors come from verified job identity. Never trust
  actor ids supplied in forms, query parameters or cookies. `requireMemberActor`
  is explicitly member-only.
- `hq_hackathon` is navigation state, not permission. Check the actual record's
  edition in scoped operations. `assertHackathonMatches`/`inHackathon` return
  the same absence for a missing record and one outside the requested edition.
  An operator authorization result does not prove that a record exists.
- `authorizeProjectAction` reads current membership, capabilities and assignment
  on each call. Team membership is checked first. A Captain grant alone opens
  no project; the grant and current assignment are both required. Team membership
  changes require the owner relationship, not Captain status.
- `authz-decisions.ts` and its `authz.ts` re-export are session-free.
  Reporting and operator action utilities import the decision/SQL
  leaves so they cannot pull member auth, Better Auth or mail into that graph.
- Every protected page and Server Action has its own gate. The member layout
  supplies account display state and does not authorize its children. Member
  denials render identically (`TEAM_NOT_AVAILABLE`) without exposing an internal
  denial reason or whether another team's record exists.
- `MEMBER_PUBLIC_PATHS` and `safeMemberNext` in `member-routes.ts` are the one
  route policy used by proxy, auth redirects and link helpers. Each new action
  module is classified in `ACTION_GATES` in `tests/hq/auth-boundary.test.ts`.
- A verified member has a verified real login email or a live Telegram identity.
  Telegram-only placeholder email remains internal; sessions and member/admin
  display DTOs expose null instead. `placeholder-email.ts` is the shared leaf.
- Telegram identity must match a live Better Auth provider account. Unlinking
  or interrupted cleanup cannot leave a bot identity usable without that account.
  Telegram user ids cross JSON boundaries as strings; the signed `id` accepts
  only the validated canonical value, and OIDC `sub` is a distinct account key.
- Linking/unlinking and changing email require a recent session and expiring,
  single-use intent. Change-email intent is bound to the normalized address;
  current email is refused. Verification goes to the new address; the previous
  verified real address is notified after the change. Preserve the account id,
  teams and grants through linking, and refuse removal of the last login method.
- Bot messaging consent is separate from authentication and Captain access.
  Turning messaging off never removes website access. Unconfigured providers
  remain unavailable, and a Telegram outage must not disable email sign-in.

## Capabilities, CRM identity and audit

- `Capability = "captain"` is an account-global grant. `grantCapability` and
  `revokeCapability` are its idempotent writers. Grant/revoke and audit are
  atomic; revoking Captain also clears all current assignments atomically.
  People role labels, displayed tags and membership tiers grant no permissions.
- People controls resolve the card's linked account within the selected edition
  before delegating to capability actions; unlinked hand-entered cards cannot
  grant an account anything. Invitation revocation and grant revocation differ:
  the first stops new redemption; the second removes existing Captain access.
- CRM people are stable identity records; edition People cards and roster rows
  reference them. Match by validated identity, never display name. Claiming a
  roster row reuses the account's person and never takes another account's CRM
  identity. `correctPersonMatch` explicitly detaches/links/merges with a reason;
  it does not silently change roles, tiers or grants.
- `AUDIT_EVENT_KINDS` in `audit-sql.ts` is the sole event vocabulary. Events are
  append-only metadata: actor, subject, edition/project, ids, reasons and counts.
  Note/update bodies never enter audit, activity or reminder logs. The audit
  module exposes no update/delete operation. System actors have no operator id.
- `CapabilityGrant`, `AuditEvent`, removal impacts and full operator query shapes
  stay operator-only. Member responses use `view-models.ts` and explicit DTOs.
  Public leaderboard rows expose rank, display name, assignment count and
  `isYou`, not account ids, another Captain's project ids/links or grant reasons.

## Colosseum import and joining

- Self-service import previews a project in the Netherlands and the configured
  external edition, then binds the selected Colosseum roster entry to the
  verified signed-in account in one transaction. These are the accepted trust
  rules: roster selection is a claim, not external ownership proof. There is
  no approval queue or proof challenge. A disputed claim goes to the existing
  Superteam NL contact/admin-removal flow; do not silently introduce a new gate.
- `gateProject` owns the country/edition decision; the import transaction
  rechecks the same facts. External edition id/slug and onboarding availability
  are operator data in `hq_hackathon_onboarding`, never seeded constants or
  environment values. Missing mapping refuses import. Internal HQ edition ids
  must never be treated as external ids.
- Successful imports retain `verification = 'verified'`, which membership
  readers require. Duplicate imports create no second team or person and reveal
  no importing account. Legacy unverified claims do not gain access implicitly.
- `parseColosseumProjectUrl` accepts the direct public project path and saved
  legacy `/arena/projects/explore/<slug>` form. It validates HTTPS, exact host
  and slug before a fixed API request; credentials, extra/dot segments and bare
  directories are refused. `colosseumProjectUrl` provides canonical storage.
- Every refusal has its own actionable message: malformed URL, unmapped/wrong
  edition, wrong country, missing project, duplicate, timeout, rate limit and
  invalid/source-rejected response remain distinct. Upstream error text is
  retained only as operator data, never displayed to members or rendered as HTML.
- Reusable team links let verified accounts claim an available roster entry.
  One account claims one entry per project; concurrent claims serialize.
  Existing single-seat links retain their expiry/use semantics. Joining refreshes
  and verifies source project, country and edition before offering or claiming
  an entry; unavailable source means retry, not stale claiming.
- Unclaimed source roster entries do not create People records. Refresh preserves
  claimed HQ membership, notes and Captain assignment. An upstream roster removal
  alone does not revoke an established HQ relationship. No available entry means
  add the person on Colosseum and refresh through the existing flow.
- Import-help requests can create a manually owned HQ project without a fabricated
  external id or submission signal. Attaching its later source keeps that same
  project id, owner, Captain and updates; request resolution is idempotent.
- `colosseum-schema.ts` owns upstream field names; `colosseum-snapshot.ts` owns
  normalization and `interpretSubmission`. `submittedAt` is submission evidence;
  `projectCompletion` is only optional readiness data. Unknown/unavailable source
  never becomes a negative submission signal. Failed refresh retains last good
  data and records attempted/check/error state.
- Listing availability is not a registration feed: disabled directories and
  unknown deadlines are unavailable, not zero registrations. The bounded deadline
  reader uses the listing's `hackathons` envelope. No general discovery/comment
  client is required. Fixture assumptions and upstream observations are recorded
  in `tests/hq/fixtures/colosseum/README.md`, not treated as permanent API promises.
- Remote project images are direct browser requests with `no-referrer`, not an
  unrestricted server image proxy. Only the trusted local fallback at
  `PROJECT_FALLBACK_IMAGE` uses `next/image`; it is never a human avatar fallback.

## Captain invitations and assignments

- Invitation expiry, revocation and capacity apply on redemption. Preview/GET,
  failed signup and repeat acceptance spend no capacity. Redemption and manual
  grants serialize on the recipient profile; successful grant/redemption/audit
  commit together. The bearer URL is exchanged for a short-lived continuation.
- A Captain cannot be assigned to their own team through membership, linked
  roster identity or legacy claimant relationship. Preserve the service's lock
  ordering, including roster CRM-person locks in id order, when changing claims,
  identity correction or assignment. A preflight check cannot replace the locks.
- Assignment history survives reassignment. Current access uses current grants
  and assignment; weekly closure uses the assignment at that week's boundary.
  Global Captain grants and edition-specific assignments must remain distinct.

## Reporting and privacy

- Keep `reporting.ts` as the public API; its internal split introduces no new
  authorization rules or transaction boundaries. Schedule/enrolment remains
  separate so imports can enrol inside their own transaction without a cycle.
- Reporting belongs to `hq_projects`, including manually owned CRM projects.
  Roster/source metadata is optional; it must not prevent a weekly update or
  Captain assignment. Member page DTOs omit operator-only account metadata and
  completion basis that would reveal the existence of a private note.
- The campaign window comes from HQ edition dates, timezone from settings and
  reporting options from `hq_reporting_config`. The official Colosseum deadline
  is separate and never moves that window. Period identity is its sequence.
  `previewReportingPeriods` writes nothing; applying cannot move/remove a period
  with entries, outcomes or closure. Live date edits retain preview/apply steps.
- Periods compare `startsAt` and exclusive `endsAt`; display inclusive
  `startDate`/`endDate`. A save uses one instant for period choice and timestamp.
  Future periods cannot be completed early. Eligibility and pause history govern
  accountability, including closure that runs after the period has ended.
- SQL applies entry audience before returning rows. Shared entries require
  current project access. Sensitive entries are visible only to their author
  and operators; another member/Captain receives neither text nor existence.
  A reassigned author with Captain capability can retain read-only access to
  their own sensitive notes; editing still requires current project permission.
  Voided entries are excluded from member reads; revisions are operator-only.
- Only an authorized team member's update sets `counts_toward_completion`.
  Captain/operator notes, shared or sensitive, do not mark a team Updated.
  Membership wins over a global Captain capability: a Captain posting on their
  own team cannot hide the update or claim Captain-only behavior there.
- Pass the draft's `expectedPeriodId` and edit version unchanged. `period_changed`
  writes nothing and requires explicit choice before moving text; `conflict`
  returns the saved version while preserving unsaved text. Page refreshes keep
  draft identity and replace newly unreadable/voided entries rather than retaining
  stale bodies. Bot and web use the same service refusals.
- `closePeriod` is idempotent history. Late entries complete nothing; voiding
  recalculates an open week but does not rewrite a closed outcome. Only
  `correctOutcome`, with reason and audit, records a correction beside the
  original. Effective completion is `COALESCE(corrected_completed, completed)`.
  Member actors cannot correct outcomes; operators and authorized job flows can.
- Status contains no entry bodies. Do not infer completion from visible entries
  or add hidden-note counts/previews. Reporting vocabulary stays Updated/Not
  updated; delivery and submission states remain separate lines and concepts.
- Team contact is opt-in and explicitly set by the team lead. Never derive it
  from login email or source data. Captain contact reads the linked Telegram
  username, with legacy `captain_contact` only as a read-only fallback. Partner
  organisation contact is a different field and grants no account relationship.
- Reporting copy lives in `reporting-view.ts` and submission copy in
  `submission-readiness.ts`; keep the existing copy/character checks covering
  these modules and their consumers. There is no separate update-prompt state.

## Telegram, reminders and jobs

- The webhook has its own constant-time secret check, byte-bounded streaming
  body and validated schema. It trusts no browser cookie/session and returns
  unavailable when unconfigured. Telegram actor lookup, messaging consent and
  Captain/current-project access are checked separately on each update.
- Bot commands use the same reporting reads/writes with `source: "telegram"`.
  Opaque callback ids resolve server-side account/chat/edition-bound, expiring
  state. Draft buttons also bind the draft generation and revision; an old Save
  cannot save whichever draft currently exists.
- Update receipts deduplicate webhook redelivery; consuming an action deduplicates
  a button; claiming the draft deduplicates a logical save across buttons. Receipt
  completion is fenced to its processing attempt. Failed/expired leases retry
  within bounds; completed receipts are terminal.
- Action consumption, draft claim, entry/revision write, resulting status and
  queued confirmation share one transaction. Service refusal rolls it all back
  and preserves text for recovery. Menus/previews send directly; retryable direct
  failure returns a retryable webhook outcome rather than acknowledging lost work.
- Outgoing queue records carry confirmation/news, never update bodies. Before
  each send, recheck identity/provider account, consent, bound Telegram identity,
  chat and current project authorization. A relink cannot inherit the old chat.
  Claims bound concurrent drains; expired claims recover, but delivery is not
  exactly-once when a transport answer is lost.
- Timeouts are uncertain, distinct from confirmed refusal even after retry
  exhaustion. Honor backoff and Telegram `retry_after`; stop permanently for a
  blocked bot. Pack escaped messages within limits before transport, never slice
  HTML. Escape all interpolated project names, contacts and text. Own-note reads
  use keyset paging and open full notes, with editing gated against current access.
- `runDueWork` owns scheduled work. Due queries evaluate stored state at an
  instant/window; no module starts its own timer or relies on one cron invocation.
  Job stages share an invocation deadline and a send budget; partial progress
  is reported honestly because stages commit separately.
- Reminder uniqueness is Captain + edition + period + type, enforced in the DB
  and outbox dedupe key. `outstandingForCaptain` re-evaluates inside preparation
  and again immediately before every send, rebuilding the body. Queue-time facts
  are insufficient; other workers also drain the same outbox.
- Record skipped delivery reasons even when nothing sends. Dispatch state never
  changes a team's weekly status. Expire ended reminders rather than an arbitrary
  age TTL. Explicit resend rechecks edition, current outgoing id, current access,
  consent and period; sent/queued/uncertain or ended/archived reminders cannot be
  resent. Run now does not bypass reminder deduplication.
- Close elapsed periods oldest first, even for archived editions, using Captain
  assignment history at the exclusive period end. Archiving stops reminders.
  Purge expired chat state and retained delivery history according to their
  constants; sweep reminder history only for closed weeks. Audit and reporting
  outcomes are separate durable history. Reminder records count teams without
  retaining their names.
- Job endpoints verify GitHub signature, issuer, audience, repository and immutable
  ids, branch, allowed event/runner and exact workflow. HQ jobs and Luma use
  separate audiences/workflows. No member/operator cookie authenticates a cron
  call; operator Run now is a separate gated entry to the same service.

## Submission evidence

- Checklists are pure presentation, never submission evidence or completion.
  Required/optional materials are operator configuration; unclassified means
  unknown, not required. Each material checks its own field and identifies URLs
  reused across materials. Do not infer a submitted project from readiness.
- Official deadline has provenance and a checked timestamp. A failed lookup
  leaves its prior value intact. Submission completion uses that deadline when
  available and the period's exclusive end otherwise.
- Background source refresh is explicitly configured, bounded and selected from
  stale eligible projects in open submission periods; archived/paused projects
  are excluded. Failed attempts advance the attempt clock so other work can run.
- Reconciliation opens from stored closed outcomes, so interruption between
  closure and opening is recoverable. Unknown/unavailable evidence stays pending.
  Capture the cutoff when the reconciliation opens; judge timestamp evidence
  against that cutoff, not discovery time or later settings changes.
- Discovered on-time submission can call audited `correctOutcome`; late submission
  corrects nothing. Resolved/corrected rows remain idempotent. `submissionFocusFor`
  is the shared authorized composition, and the operator board reads the same
  stored source evidence. `completedBySubmission` derives from that project's
  evidence, not a completion basis that could reveal another private entry.

## Deletion, migrations and verification

- `record-deletion.ts` owns project/People deletion. Operator gate and edition
  scope precede it; actual impact counts are read for confirmation and again
  inside the audited deleting transaction. New references to projects, People
  cards or CRM people require an explicit cascade/detach decision in this module,
  the impact DTO and regression tests.
- Project deletion removes dependent source, ownership, roster, entries/revisions,
  eligibility/pause, outcomes and assignments. Awards survive with winner cleared;
  import-help requests detach; edition periods remain. Submission reconciliation
  cascades but adds no separate confirmation count beyond its recorded week.
  Expiring bot state grants no access after deletion and is purged independently.
- People deletion never deletes the sign-in account. The last card may remove its
  CRM person while roster rows detach, not disappear. Reporting history survives
  because it belongs to the account/project, not the card; later login may create
  a fresh card. Judge scores follow the defined card deletion cascade.
- Follow [the migration guide](../../scripts/hq/migrations/README.md): one dedicated
  connection/advisory lock, ordered migrations, checksum-verified `hq_migrations`
  ledger, and atomic migration + ledger commit. The frozen legacy bootstrap
  preserves fresh and populated-database upgrade paths; do not append new DDL
  to its input files. Add forward migrations, never rewrite applied history.
- Reset classification remains explicit for every operational `hq_%` table.
  `hq_migrations` is infrastructure history and survives reset; `hq_luma_sync`
  has a dedicated rewind. Seed configuration idempotently, never the external
  Colosseum mapping. Fixtures contain invented identities, not real user data.
- `tests/hq/helpers/db.ts` applies the production migration sequence to isolated
  PGlite databases. Rollback, access, privacy, deletion and idempotence need
  behavior tests. PGlite's single connection does not prove concurrent PostgreSQL
  interleaving; retain SQL lock/index guards and verify concurrency where needed.
- Import-boundary tests use the TypeScript AST, following runtime imports and
  re-exports while ignoring explicit type-only edges. Keep positive controls so
  a broken scan cannot pass by finding nothing. Static/render/PGlite tests do not
  prove live sign-in, external delivery or production environment configuration.
