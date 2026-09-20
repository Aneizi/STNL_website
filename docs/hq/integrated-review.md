# HQ integrated implementation review

15 September 2026 · branch `hq-captains-phases-0-2`

**16 September follow-up:** Direct Colosseum project links now parse before the
API request; legacy links still work. Canonical storage, unsafe-input rejection
and member import/help regressions passed in 207 tests across five affected
suites. See the [implementation log](implementation-log.md) for the scope and
verification limits of this follow-up; the full-review results below remain
the 15 September record.

## Scope and conclusion

Reviewed phases 0–8 and 10 against
`docs/plans/2026-09-13-hq-captains-and-colosseum.md`, the implementation log,
contracts, source, schema and tests. The starting commit was `9b58267`. The
checkout also contained uncommitted Phase 10 changes; the owner confirmed those
were part of this review and no other agent was editing the checkout. They were
preserved. Phase 9 remains removed.

The main module boundaries are appropriate: one application, shared authorization
and reporting services, a separate Telegram adapter and bounded scheduled jobs.
The review found and fixed correctness, privacy, refresh and scheduling defects;
it did not introduce a new architecture or a general workflow framework.

**This is a code handoff for isolated testing, not public release approval.** No
live database migration, provider configuration, message delivery, deployment,
merge, commit or push was performed. Device and external-provider verification
wait for the owner's setup and next request.

## Findings resolved

| Area | Problem | Result |
|---|---|---|
| Account reads | Every authenticated read wrote an unchanged profile in a transaction | Read-only fast path; actual changes and repair remain transactional |
| Telegram identity | Failed unlink cleanup could leave an identity usable after its provider account was deleted | Shared live-account predicate protects website identity, bot access and delivery |
| Invitations | Different invitations redeemed concurrently by one account could each consume capacity | Recipient profile lock serializes grants as well as invitation capacity |
| Roster identity | Joining a roster seat could move a CRM identity already attached to another account | Member redemption refuses reassignment; explicit operator correction remains |
| Join reliability | A valid HQ link depended on another successful live Colosseum fetch | Saved HQ roster, available seat and valid importer-issued link are sufficient |
| Source refresh | A reused or changed source URL could overwrite another external project's details | Stored external project and edition IDs must match |
| Reporting time | Explicit future periods could be completed early; timestamp/period decisions could disagree | Future saves refused; saved timestamp and qualifying window checked consistently |
| Reporting input | Malformed UUID/cursor/date/time values could reach invalid SQL or normalize into another date | Structured refusals and strict calendar/time validation |
| Missing screens | Service-supported late updates and admin creation/editing were unreachable | Member late composer; shared-service operator create/edit, conflict and audience controls |
| Browser state | Saved updates could stay stale; refreshed props could silently advance a draft's week or version | Authoritative list refresh; draft period and edit version stay pinned until explicit choice |
| Captain reads | First-page history was loaded through repeated per-team authorization/query chains | One bounded, audience-filtered query for assigned projects; reporting status reused |
| Telegram drafts | Preview retry lost controls; non-default edition context was lost; old-note lookup scanned pages | Recoverable preview controls, retained edition context and direct authorized note lookup |
| Telegram content | Long messages lost whitespace or produced oversized note menus | Lossless splitting and bounded menu responses |
| Delivery workers | Batches outlived claims/time budgets; final-attempt crashes could leave records queued | Per-message claims, shared deadline, response-time retries and uncertain-delivery recovery |
| Delivery privacy | Deleted account recipients could fall through the null-recipient path | Missing recipients fail closed; active identity/consent/resource checked before sending |
| Webhook overlap | An old worker could complete a receipt now owned by a replacement | Attempt-fenced completion and retryable overlap response |
| Reminder lifetime | Buttons expired before the reporting period ended; cleanup could race a live send | Period-scoped controls and active-claim-aware cleanup |
| Submission fairness | The same unavailable projects monopolized scheduled refresh batches | Persisted attempt time advances on both success and failure |
| Submission evidence | Unknown evidence could be marked resolved; outage-time deadline edits changed later judgment | Unknown stays pending; cutoff captured when reconciliation opens; late discovery remains distinct from late submission |
| Migration reruns | Raw URLs rejected by import could be backfilled into safe columns; malformed arrays/IDs aborted reruns | Constrained URL backfills, guarded JSON operations and bounded scalar/nested edition-ID backfills |
| Payload/layout | Large original fallback avatar; eagerly loaded admin reporting controls; narrow-screen overflow | Local image optimization, deferred admin panel, wrapping and larger touch controls |
| Dependencies | Published Next.js/image-processing and transitive vulnerabilities | Next.js 16.3.5, Vitest 4.1.11 and compatible lockfile security patches |

Dependency advisory references: [Next.js AVIF processing](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4)
and [sharp image processing](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).

Critical paths are covered by regression tests, including real service queries
against embedded PostgreSQL and the installed Better Auth library. Transaction
ordering tests on PGlite do not substitute for simultaneous production PostgreSQL
connections; that remains an explicit staging check.

## Cleanup and maintainability

- Removed obsolete pending/rejected import screens and `ownClaim`, the test-only
  production `BuilderStore.team` convenience method, unused database aliases,
  the unused `getToday` wrapper and unused callback/type plumbing.
- Kept SQL authorization, submitted/on-time semantics, source interpretation and
  bot delivery identity checks shared. No browser polling or new UI framework.
- Removed the dashboard weekly-summary client boundary because it has no state
  or event handlers. The operator reporting detail is a deferred chunk.
- Replaced the literal NUL in the URL-validation regex with its equivalent
  escaped spelling so the source remains reviewable as text.
- Rewrote the owner manual around preparation, isolated activation, validation
  and rollout; included a names-only environment template.
- Clarified that the manual job action processes all editions in the deployment,
  and documented the import enablement/access-date prerequisite.
- Three ignored local performance probe routes had no application callers but
  appeared in the build. Moved their directory out of `app/` to
  `/tmp/hq-review-2026-09-15-archived/perftest-tmp`, preserving the files.

No compatibility migration for public accounts was invented: the approved
baseline says public signup had not been released. Operator credentials and their
independent authentication boundary are preserved.

## Validation record

- The final complete run passed **1,521 tests across 61 files** with
  `npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000`.
  This includes the latest UI state, authorization and migration regressions.
- The final **production build and `npx tsc --noEmit` passed** after removing
  the ignored scratch routes. The route list contains no performance probes.
- Final **ESLint: zero errors, 18 existing unused-variable warnings** in
  `public/deck/deck-stage.js`. Scoped lint checks for the changed UI also passed.
- Final **`npm audit --audit-level=moderate`: zero known vulnerabilities**.
  No extra production dependency was added.

The final run took 20 minutes 39 seconds on this machine. Earlier in the review,
a complete post-change run passed 1,510 tests in roughly 64 seconds; the final
ordinary run and single-worker retry later hit the default five-second limits
in embedded PostgreSQL tests. A standalone fresh PGlite plus `SELECT 1`, with no
HQ schema or Vitest, also took about 13 seconds during the slowdown. The cause
of that local runtime slowdown was not established. The successful final run
used the temporary command-line allowances above, with unchanged assertions;
the repository's test timeout configuration was not relaxed. Vitest's automatic
agent reporter hides passing modules until its final summary. Use
`--reporter=default` for visible module progress when diagnosing another run.

The UI state tests exercise real event handlers with a small hook harness and
SSR tests render real components. They do not establish browser event, focus,
layout or device performance behavior. The local Node runtime is 22.23.1; the
repository's Node 24 CI run still belongs to the later review/rollout workflow.

## Performance assessment

The changes remove avoidable writes, duplicate aggregates, per-team first-page
queries and unbounded note lookup work. Histories and revisions remain paged;
Colosseum refresh and Telegram delivery have bounded work. No heavy client
library was added. The local fallback no longer requires every browser to fetch
the full 1.1 MB source image for a small avatar.

A production build's route entry chunks are measured below. These are gzip sums
of `entryJSFiles` in Next's client reference manifests, not complete page-transfer
sizes: framework boot scripts, CSS, images, server-rendered data and deferred
chunks are excluded. Shared chunks are also reused across navigations.

| Route | Entry chunks, gzip |
|---|---:|
| Member dashboard | approximately 38 KiB |
| Captain | approximately 39 KiB |
| Member team | approximately 45 KiB |
| Operator Projects | approximately 40 KiB |
| Operator Admin | approximately 41 KiB |

These measurements are useful for detecting client bloat; they are not evidence
of a particular device's speed. Real request latency, connection-pool behavior,
full transfer size, responsive layout and slow-network interactions must be
measured with representative synthetic data in the next session. Large operator
boards still render their edition's records together; we have not introduced
virtualization without a measured need.

## Product choices retained

Two optional questions were raised during the review. With no answer received
while independent work continued, the following assumptions were stated before
proceeding:

1. **Joining uses the saved HQ roster**, consistent with immediate link-based
   joining in the approved plan. Source outages no longer prevent it.
2. **Deleting a person does not delete their sign-in account.** A later login
   can create a new People card. This preserves the existing behavior.

Also retained: an upstream roster removal does not revoke verified HQ membership;
historical roster participants remain visible. Voiding a closed-period entry
preserves the recorded outcome until an admin explicitly corrects it with a
reason. These are intentional current behaviors, not claims that those actions
perform account deletion or retroactive erasure.

## What remains before release

Follow [the owner manual](manual-setup.md), then request the isolated test
environment. It covers the stable staging origin, Resend DNS/key, separate test
Telegram bot/login credentials, private environment values, database recovery,
Colosseum mapping, reporting periods, official deadline and material requirements.

The next session must exercise:

- Real email/Telegram login and linking, operator login and provider failures.
- Concurrent invitation, membership, reporting and worker races on real PostgreSQL.
- Team → Captain → admin access/privacy, edits, late updates and deletion impacts.
- Bot commands, reminders, retries, period closure and submission reconciliation.
- Mobile Safari/Chrome and desktop browsers, keyboard/reduced motion, slow-network
  behavior, representative query counts and authenticated page payloads.
- An isolated migration/restore rehearsal before production migration and rollout.

No public release should be inferred from the automated test results alone.
