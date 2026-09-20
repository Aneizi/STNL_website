# HQ audit cleanup — 20 September 2026

This implements the overlap between the two codebase audits that can preserve the
active interface and workflows. Colosseum ownership verification is unchanged.
No live database migration, live data deletion, or deployment was performed.

## Implemented

| Area | Change | Compatibility evidence |
| --- | --- | --- |
| Database access | One lazy `pg` pool serves operator SQL, callback transactions, and Better Auth. Removed the Neon HTTP driver dependency and environment-specific adapter. | Real PostgreSQL statements in PGlite test parameter binding, lazy execution, transaction rollback, connection release, and shared pool identity. Existing call shapes remain available. |
| Migrations | Checksummed `hq_migrations` ledger, ordered migrations, advisory lock, and atomic migration/ledger commits. Historical setup becomes a one-time bootstrap that preserves customized classifiers and normalized snapshot values. | Fresh databases, populated current databases, legacy upgrades, first-adoption preservation, replay prevention, checksum drift, rollback/retry, and concurrent runners are tested. |
| Read efficiency | Request-scoped caching of edition/settings/classifier reads; one Captain team batch; direct edition lookup; one search query. | Query-count and ordering tests preserve authorization, category priority, limits, and literal search matching. React caching is per render, not a persistent cross-user cache. |
| Data payloads | Dashboard fetches only fields it renders. Team reads select explicit columns and exclude raw upstream JSON. | Dashboard output is compared byte-for-byte against the previous full-project projection; team view models are tested. |
| Public interest | Removed per-request schema probing and historical unscoped SQL. Builder role creation/read is one atomic upsert preserving operator settings. | Four-query budget plus deduplication, parameterization, edition selection, judge-role protection, and atomic-write tests. Requires the migrated schema already used by HQ. |
| Rate limiting | One fixed-window implementation; existing namespaces, limits, messages, window boundaries, and successful-login credits remain. Counters saturate above the cap. | Concurrent bursts, expiration, success credits, and existing authentication/ invitation tests. Retention moves to bounded scheduled batches rather than public requests. |
| Refresh behavior | One domain-aware revalidation helper, including dependent screens. Edition/catalog changes retain layout invalidation. | Tests cover public interest scope, project dependents, dynamic route patterns, and edition switching scope. No optimistic state or loading behavior was removed. |
| Reporting structure | Split entries, status, outcomes, and shared internals behind the existing reporting API. Removed historical narrative while retaining invariants. | Existing reporting suites and declaration equivalence checks preserve SQL, authorization, outputs, and transaction behavior. |
| Duplicate/dead code | Shared identical error-boundary component; removed unused `isRetryable`, `getEventOptions`, and `EventOption`. | Existing route boundaries remain; rendered error content and callbacks are unchanged. |
| Static assets | Deleted the unused full Figma export, `ColosseumWorldsFairNL.jpg`, and `SuperteamNL-Logo.svg`: 16,774,739 bytes removed. | Checked source, styles, HTML and dynamic asset references. The pitch deck still uses `canal-illustration.png`, so that asset remains. |
| Security headers | Global MIME-sniffing protection and referrer policy; HQ framing/base/object restrictions; HSTS on Vercel. Bearer invitation/join pages retain `no-referrer`. | Next's config routing tests verify header matching/override order and the pitch-deck rewrite. Resource-loading directives were not tightened, preserving existing media/scripts/styles. |
| Tooling and documentation | Staging CI, read-only CI token permissions, zero-warning lint, scratch/vendored lint exclusions, and deployment exclusions. Current contracts replace phase history, with the original archived. | Lint, type checking, full test suite, and production build are the release checks. |
| Boundary tests | Shared TypeScript syntax-tree import analysis replaces fragile import regexes for operator/member boundaries. | Covers side-effect imports, lazy imports, re-exports, and explicit type-only syntax while retaining forbidden-dependency checks. |

## Dedicated pruning pass

Compared with the working tree at the start of the follow-up request, production
source fell from **41,217 to 38,782 lines**, across **263 to 261 files**. The net
reduction is **2,435 lines**: **578 code/declaration lines**, **1,818 comment lines**,
and **39 blank lines**. These counts cover `app/`, `components/`, `lib/`, and
`scripts/`; they exclude tests, documentation, assets and merely moved files.

- Removed five server actions with no production callers: `setProjectStatus`,
  `logMondayReview`, `refreshBuilderTeam`, `previewReportingSchedule`, and
  `updateBuilderTier`. The active project editors, scheduled/manual source checks,
  reporting configuration and capability administration remain.
- Removed obsolete generic actor/operator wrappers, unused audit-list pagination,
  old Captain list/view helpers, unused submission copy/summary/date helpers,
  singular reads superseded by batch reads, and the unused enrollment API.
  Historical database records and migrations remain intact.
- Consolidated four field-update switches, snapshot types and inserts, default
  project creation, import preflight, auth form state/shells, and SVG wrappers.
  Made 128 internal exports private and removed the redundant `@types/bcryptjs`
  dependency; bcryptjs supplies its own types.
- Removed development-history prose while keeping authorization, privacy,
  transaction, retry and compatibility invariants. Comment-only edits were checked
  for identical emitted JavaScript; surviving functions in the deletion pass were
  independently compared against the saved baseline.
- Deleted tests for retired APIs. Existing mutation/security assertions now use
  active batch readers or inspect persisted rows. Added real-database regressions
  for selected-field-only writes, bound values, related records and rollback.
- Checked identical HTML for 28 auth/icon variants and identical auth event/state
  behavior for 24 observations. Existing Events/Projects JSX is unchanged after
  expanding the shared styles. No CSS or product interactions were changed.

## Validation results

- `npm run lint`: passed with zero warnings.
- `npx tsc --noEmit --incremental false`: passed.
- `npm test`: **94 suites, 1,934 tests passed**.
- `npm run build`: passed with database connection variables empty.
- `npm audit --omit=dev --audit-level=high`: **zero vulnerabilities**.
- `git diff --check`: passed; package manifest and lockfile dependency maps agree.
- Independent syntax/render comparison found no presentation or interaction
  changes in the modified TSX files. No authenticated staging/browser smoke test
  or real database migration was performed.

## Deliberately excluded

- Ownership proof, new password fields/reauthentication flows, pagination, loading
  controls, styling changes, and client-component rewrites that could change UI/UX.
  The existing password-change reauthentication gap therefore remains a separate
  security task requiring an approved interaction change.
- Destructive removal of historical tables or migrations. Existing data was not
  inventoried for deletion; old upgrade paths must remain available when adopting
  the ledger. Future removal belongs in an explicit forward migration after review.
- Broad code formatting and automatic deletion of recently added brand assets.
  Test-only functions were removed only after tracing production callers; active
  internal helpers retain tests even where no other production module imports them.
- A strict script/resource CSP. The added policy closes HQ framing and object/base
  gaps, but is not a complete XSS policy. A nonce/resource policy needs separate
  runtime verification against all supported media and authentication flows.
- A dependency-version upgrade or a claim that the complete production environment
  has been security-audited. This change removes an unused driver dependency;
  deployment settings and third-party provider configurations remain environment-specific.

## Deployment requirements

1. Exercise this build in staging using the pooled PostgreSQL `DATABASE_URL`.
   In-memory tests do not measure Neon network latency or deployment connection limits.
2. Take the normal database backup and run `npm run hq:migrate` against the intended
   direct `DATABASE_URL_UNPOOLED`. First adoption runs the historical upgrade path
   once, atomically; later invocations skip it. Do not edit bootstrap inputs after
   that first ledger entry. See [migration instructions](../../scripts/hq/migrations/README.md).
3. Verify operator/member sign-in, project editing/import/join, Captain reporting,
   search, the public interest form, and the existing deck in staging. Confirm that
   scheduled HQ jobs run: they now own login-counter and login-audit retention.
4. Configure production naming, auth origins, provider callbacks, and job endpoints
   as usual before promotion. No provider or production naming was changed here.

The retained `getSql()` and `builderDatabase()` interfaces are compatibility entry
points over one transport. This avoids rewriting every service merely to change
its query syntax. Future services can use the callback database interface directly.
