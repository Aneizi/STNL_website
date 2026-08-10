# HQ ↔ Luma event sync

**Date:** 2026-08-10
**Status:** Approved, revised after review

## Problem

`/hq/events` and the public `/events` page both describe Superteam NL's events, but
they share nothing. The public page reads `luma.com/stnl` live through `lib/luma.ts`;
HQ reads a hand-maintained `hq_events` table. Every event therefore gets entered
twice, and the two drift.

HQ also needs things Luma cannot express — budget, leads, event type, project
attribution — so it cannot simply become a Luma mirror.

## Goals

1. Luma events appear in HQ automatically, kept current.
2. One shared module does the fetching and normalizing for both pages.
3. HQ can add **external** events that do not exist in Luma.
4. Luma-sourced events are **archivable, never deletable**. External events are deletable.
5. HQ-only metrics (budget, leads) and HQ edits survive re-syncs.

## Non-goals

- Writing back to Luma. The sync is one-way, Luma → HQ.
- Changing the public `/events` page's appearance or behaviour.
- Authenticating against Luma. The calendar endpoint is public and unauthenticated.

## Field inventory

What `api.lu.ma/calendar/get-items` returns for `cal-vZUgVHVuBRK7pSd`, verified
against the live endpoint on 2026-08-10:

| HQ column    | Luma source                                  | Sync behaviour |
|--------------|----------------------------------------------|----------------|
| `name`       | `event.name`                                 | Synced, pinnable |
| `date`       | `event.start_at` in `event.timezone`         | Synced, pinnable. Calendar day, not the raw instant |
| `end_date`   | `event.end_at`, null when same calendar day  | Synced, pinnable |
| `venue`      | `event.geo_address_info.address`             | Synced, pinnable. Null when hidden or URL-only |
| `cohost`     | `entry.hosts[].name` minus "Superteam NL"    | Synced, pinnable |
| `attendance` | `entry.guest_count`                          | **Insert only.** `0` on most events (hidden guest lists), and it counts registrations, not attendance. HQ-owned after insert |
| `type_id`    | *not in Luma*                                | Insert only, guessed from the title. HQ-owned after insert |
| `spend`      | *not in Luma*                                | HQ-only, defaults to 0 |
| `leads`      | *not in Luma*                                | HQ-only, defaults to 0 |

`attendance` is deliberately **insert-only rather than pinnable**. A field that is
seeded once and thereafter owned by HQ needs no pin, and treating it as continuously
synced would mean a later Luma value silently overwriting a hand-counted headcount.

Luma's `tags` are `Buildstation`, `Hackathon`, `Official Event`; HQ's type labels are
`Workshop`, `Demo day`, `Weekly coworking`, … . They do not overlap, so tags are not
used for typing.

## Architecture

### 1. Shared module

`lib/luma.ts` currently mixes three concerns. Split along them:

- **`lib/luma/client.ts`** — `fetchCalendarEntries(period, { cache })`. Owns the HTTP
  call, the raw `LumaEntry`/`LumaEvent` types, **pagination**, and response
  validation. The public ledger passes `next: { revalidate: 300 }`; the HQ sync
  passes `cache: "no-store"` **explicitly**, rather than relying on the route's
  `force-dynamic` to imply it.
- **`lib/luma/normalize.ts`** — `toLumaEvent(entry): NormalizedLumaEvent`, the neutral
  domain type both consumers share:

  ```ts
  type NormalizedLumaEvent = {
    lumaId: string;      // event.api_id — stable across renames
    name: string;
    startAt: string;     // ISO instant
    endAt: string | null;
    timezone: string;
    date: string;        // YYYY-MM-DD in the event's timezone
    endDate: string | null;  // set only for multi-day spans
    days: number;
    venue: string | null;
    city: string;
    cohosts: string[];
    guestCount: number;
    tags: string[];
    coverUrl: string | null;
    blurb: string | null;
    url: string;         // https://luma.com/<slug>
    featured: boolean;
    live: boolean;
  };
  ```

- **`lib/luma/ledger.ts`** — the public-site adapter. `getUpcomingEvents()` /
  `getPastEvents()` keep their current signatures and `LedgerEvent` shapes, but map
  from `NormalizedLumaEvent`. Presentation-only concerns (`TINTS`, `dow`/`day`/`mon`
  parts, `monthLabel`, the `time` range string) stay here.
- **`lib/luma.ts`** becomes a barrel re-exporting `ledger`, so `app/events/page.tsx`
  and `components/events-ledger.tsx` need no changes.

HQ's sync imports `client` and `normalize` only. It never touches `ledger`.

#### Pagination and validation

The endpoint returns `has_more` and `next_cursor` alongside `entries`; at
`pagination_limit=100` the past feed currently returns 35 entries with
`has_more: false`, but that will cross 100 in time.

`fetchCalendarEntries` therefore loops on `next_cursor` until `has_more` is falsy,
concatenating pages, with a hard page cap (20) as a runaway guard. Reaching the cap
is an **error**, not a truncated success.

Validation is strict, because reconciliation deletes-by-archiving based on absence:
a response whose `entries` is not an array, or which lacks `entries` entirely, throws
rather than being read as an empty calendar. An empty *array* is legitimate and
handled; a malformed body is not.

### 2. Schema

```sql
ALTER TABLE hq_events
  ADD COLUMN luma_id text UNIQUE,              -- NULL ⇒ external event
  ADD COLUMN luma_url text NOT NULL DEFAULT '',
  ADD COLUMN pinned_fields text[] NOT NULL DEFAULT '{}',
  ADD COLUMN archived_at timestamptz,          -- NULL ⇒ active
  ADD COLUMN archived_reason text              -- 'manual' | 'missing', NULL when active
    CHECK (archived_reason IN ('manual','missing'));

CREATE TABLE hq_luma_sync (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),      -- single row
  last_success_at timestamptz NOT NULL DEFAULT 'epoch'
);
INSERT INTO hq_luma_sync (id) VALUES (true) ON CONFLICT DO NOTHING;
```

There is deliberately no `source` column: `luma_id IS NULL` *is* the source, so the
two can never disagree.

The seeding `INSERT` ships with the table — the row must exist for the lock below to
have anything to take. The `epoch` default guarantees the first sync runs.

All of this goes into `scripts/hq/schema.sql` for fresh databases and as idempotent
`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` steps in
`scripts/hq/upgrades.ts` for existing ones, following that file's check-state-first
convention.

#### Canonical pin keys

`pinned_fields` stores **database column names** — `name`, `date`, `end_date`,
`venue`, `cohost` — because that is what the upsert's `CASE` expressions compare
against. `updateEvent`'s action-level field names are camelCase (`endDate`), so a
single exported map is the only place the two vocabularies meet:

```ts
export const PINNABLE = {
  name: "name", date: "date", endDate: "end_date",
  venue: "venue", cohost: "cohost",
} as const;   // action field → column name
```

Nothing else may hand-write a pin key.

### 3. Sync

`syncLumaEvents({ force }: { force?: boolean })` in `lib/hq/luma-sync.ts`:

1. **Freshness precheck (advisory).** Read `last_success_at`. If it is under 5
   minutes old and `force` is not set, return `{ skipped: true }` without fetching.
   This is only an optimisation to avoid pointless HTTP; correctness comes from
   step 4. `force` bypasses this check and nothing else.

2. **Record `fetchStartedAt = now()`** before any network call.

3. **Fetch both periods, fully paginated.** Upcoming *and* past must both succeed
   and both reach `has_more: false`. If either fails, return an error and write
   nothing at all. HQ still renders from the mirrored rows, so Luma being down never
   blanks the board — and because nothing is written, the next request retries
   immediately rather than waiting out a burnt window.

4. **One transaction** — `sql.transaction([...])`, four statements:

   1. `SELECT 1 FROM hq_luma_sync WHERE id = true FOR UPDATE`
      Serialises concurrent syncs. A second sync blocks here until the first commits.
   2. The multi-row upsert (below), guarded.
   3. The archive-missing reconciliation, guarded.
   4. `UPDATE hq_luma_sync SET last_success_at = now()`, guarded.

   Every guarded statement carries the same predicate:

   ```sql
   WHERE (SELECT last_success_at FROM hq_luma_sync) <= $fetchStartedAt
   ```

   A sync that waited on the lock finds `last_success_at` advanced past its own
   `fetchStartedAt`, so all three of its writes no-op. This is why no lease is
   needed: mutual exclusion comes from the row lock, freshness from the timestamp,
   and the timestamp only ever moves **forward on success**. There is no path that
   writes a stale timestamp over a newer one.

   `lib/hq/db.ts` exposes a *non-interactive* `transaction(queries[])` — an array of
   pre-built statements with no opportunity to branch in JS between them. That is why
   the guard is expressed in SQL on every statement rather than as an early return,
   and why the upsert is a single multi-row statement fed one JSON parameter rather
   than one statement per event.

#### The upsert

```sql
WITH src AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb)
    AS x(luma_id text, luma_url text, name text, date date,
         end_date date, venue text, cohost text, guest_count int, type_id uuid)
)
INSERT INTO hq_events (luma_id, luma_url, name, date, end_date, venue, cohost,
                       attendance, type_id, spend, leads)
SELECT luma_id, luma_url, name, date, end_date, venue, cohost,
       guest_count, type_id, 0, 0
FROM src
WHERE (SELECT last_success_at FROM hq_luma_sync) <= $2
ON CONFLICT (luma_id) DO UPDATE SET
  luma_url = EXCLUDED.luma_url,
  name     = CASE WHEN 'name'     = ANY(hq_events.pinned_fields)
                  THEN hq_events.name     ELSE EXCLUDED.name     END,
  date     = CASE WHEN 'date'     = ANY(hq_events.pinned_fields)
                  THEN hq_events.date     ELSE EXCLUDED.date     END,
  end_date = CASE WHEN 'end_date' = ANY(hq_events.pinned_fields)
                  THEN hq_events.end_date ELSE EXCLUDED.end_date END,
  venue    = CASE WHEN 'venue'    = ANY(hq_events.pinned_fields)
                  THEN hq_events.venue    ELSE EXCLUDED.venue    END,
  cohost   = CASE WHEN 'cohost'   = ANY(hq_events.pinned_fields)
                  THEN hq_events.cohost   ELSE EXCLUDED.cohost   END,
  -- an auto-archived event that reappears in Luma comes back;
  -- a manually archived one stays archived
  archived_at     = CASE WHEN hq_events.archived_reason = 'missing'
                         THEN NULL ELSE hq_events.archived_at END,
  archived_reason = CASE WHEN hq_events.archived_reason = 'missing'
                         THEN NULL ELSE hq_events.archived_reason END
```

`attendance`, `type_id`, `spend` and `leads` appear only in the `INSERT` column list,
never in `DO UPDATE` — they are HQ-owned from the moment the row exists.

#### Archive reconciliation

```sql
UPDATE hq_events SET archived_at = now(), archived_reason = 'missing'
WHERE luma_id IS NOT NULL
  AND NOT (luma_id = ANY($1))    -- every id seen this sync
  AND archived_at IS NULL
  AND (SELECT last_success_at FROM hq_luma_sync) <= $2
```

Never a `DELETE` — a vanished event may carry HQ metrics and project attributions.
Step 3's both-periods-must-fully-paginate rule is what stops a truncated or failed
fetch from archiving the calendar.

One further guard: if both periods return **zero** events, the reconciliation
statement is omitted entirely and the sync reports it. `luma_id = ANY('{}')` is false
for every row, so the predicate would otherwise archive the whole calendar in one
shot. A genuinely empty Luma calendar is far less likely than an upstream shape
change that validation happened not to catch, so the safe reading of "everything
disappeared at once" is "don't believe it".

#### Manual versus automatic archiving

This is the distinction that makes archiving usable at all. Active Luma events appear
in *every* sync, so a single `archived_at` column would be cleared within five minutes
of any manual archive.

- **`'manual'`** — set by the user. Survives every sync, including ones where the
  event is present and healthy. Cleared only by Unarchive.
- **`'missing'`** — set by reconciliation when the event leaves the Luma calendar.
  Cleared automatically if the event reappears.

#### Type guessing

Applied once, on first insert:

1. Multi-day span → `Multi-day program`.
2. Otherwise case-insensitive keyword match of the title against type labels:
   `co-working`/`coworking` → `Weekly coworking`, `demo day` → `Demo day`,
   `workshop` → `Workshop`, `pitch` → `Pitch session`, `mixer` → `Community mixer`.
3. No match → `Other`.

Type is HQ-owned and always editable, so a wrong guess costs one dropdown.

### 4. Migrating existing HQ events

Adding a nullable `luma_id` silently reclassifies every hand-entered row as
*external*. The first sync would then insert a second, Luma-backed row for events
already tracked by hand — duplicating exactly what this work exists to remove, and
stranding the existing budget and leads on the orphaned copy.

A one-time **`npm run hq:reconcile-luma`** script (`scripts/hq/reconcile-luma.ts`)
runs before the first sync:

1. Fetch and normalize the full Luma calendar.
2. For each `hq_events` row with `luma_id IS NULL`, look for a Luma event with the
   same `normName(name)` (reusing the existing helper in `lib/hq/format.ts`, which
   already backs project→event attribution) **and** the same `date`.
3. Exactly one match → adopt it: set `luma_id` and `luma_url` on the existing row, so
   its metrics stay attached and no duplicate is ever inserted.
4. Zero or multiple matches → leave untouched and **print** for manual review.

The script runs `--dry-run` by default, printing the three buckets and writing
nothing; `--apply` performs the adoption. It is deliberately a script rather than a
step in the sync path: matching production rows on a name heuristic is irreversible,
and irreversible heuristics do not belong in a page load.

### 5. Field ownership and pinning

`name`, `date`, `end_date`, `venue` and `cohost` are Luma-backed and pinnable. They
are freely editable in HQ; editing one on a Luma row appends its column name to
`pinned_fields` in the same transaction as the edit, and subsequent syncs leave it
alone. Releasing the pin restores Luma's value on the next sync.

`type_id`, `attendance`, `spend` and `leads` are HQ-owned after insert. They are never
written by a re-sync and need no pinning.

External events (`luma_id IS NULL`) ignore pinning entirely.

### 6. Actions (`lib/hq/actions/events.ts`)

All call `requireUser()` first, log through the existing `activityStmt` helper, and
call `refreshHq()` — matching every other action in the file.

- `updateEvent` — extended: on a Luma row, a write to a pinnable field also appends
  that field's column name to `pinned_fields` in the same transaction.
- `unpinEventField(eventId, field)` — removes the pin.
- `archiveEvent(eventId)` — sets `archived_at = now(), archived_reason = 'manual'`.
- `unarchiveEvent(eventId)` — clears both.
- `deleteEvent(eventId)` — `DELETE FROM hq_events WHERE id = $1 AND luma_id IS NULL`.
  Luma rows are undeletable in SQL, not merely hidden in the UI. Nothing holds a
  foreign key to `hq_events`, so the delete is safe.
- **`syncLuma()`** — the authenticated wrapper the Sync button calls.
  `components/hq/events.tsx` is a client component and cannot invoke
  `lib/hq/luma-sync.ts` directly. This action is the only entry point exposed to the
  client; it calls `requireUser()` and then `syncLumaEvents({ force: true })`, and
  returns an `ActionResult` so the button can surface a failure.

### 7. Queries (`lib/hq/queries.ts`)

`getEventsWithOutputs()` selects the new columns and returns every row carrying
`lumaId`, `lumaUrl`, `pinned: string[]`, `archived: boolean` and `archivedReason`.

Project→event attribution becomes **active-first with an archived fallback**: build
`firstEventByName` from non-archived events, then add archived events only for names
no active event claims. A live event therefore always wins a name collision, while an
archived event that is still the only match keeps its history rather than silently
dropping the projects attributed to it.

The component filters archived rows out of the list and the calendar.

### 8. UI (`components/hq/events.tsx`)

**Luma mark.** A `LumaMark` in `components/hq/ui.tsx`, alongside `Badge`: the Luma
wordmark as inline SVG, rendered as an `<a>` to `luma_url` (`target="_blank"`,
`rel="noreferrer"`). External events render no mark, so its absence is the signal.

Deliberately unadorned — no chip, border or fill. It sits immediately beside the
event name (4px), where anything with edges competed with the name instead of
annotating it.

- inline SVG at 22×8, holding the artwork's 724:264 ratio
- `fill="currentColor"`, so it takes its colour from the link and stays on-palette
- `--label-3` at rest, accented on hover through the shared `hq-hover-accent` class
- `display: block` on the SVG, since an inline SVG's baseline gap would offset it
  from the name
- `aria-label="View on Luma"` on the link with the SVG `aria-hidden`, or it would
  announce as an unlabelled link

An earlier revision used a glass chip following `chrome.tsx`'s treatment. It was
dropped: list rows sit on the opaque `--card`, so `backdrop-filter` had nothing to
blur, and at the size the row wants the chip's border read as clutter against the
event name rather than as a source marker.

**Rest of the surface:**

- Pinned fields show a subtle indicator in edit mode with a "reset to Luma" control.
- Row action is **Archive** on Luma rows, **Delete** on external rows, as an inline
  two-step (`Delete` → `Sure?`), not `window.confirm` — matching HQ's dialog-free
  style, and avoiding modal dialogs that block browser automation.
- The header gains an **Archived (n)** toggle revealing archived rows with Unarchive,
  plus the **Sync Luma** button wired to the `syncLuma()` action.
- The calendar reads from the non-archived set.
- The list has no totals row; the per-event figures are the whole story.

## Error handling

| Failure | Behaviour |
|---|---|
| Luma unreachable / non-200 | Nothing written, nothing archived, `last_success_at` untouched, so the next request retries. HQ renders mirrored rows. The Sync button surfaces the error; a page-load sync fails silently. |
| One period succeeds, the other fails | Total failure. Nothing is written. |
| Pagination incomplete (page cap hit) | Treated as failure — never a truncated success, since absence drives archiving. |
| Malformed response body | Throws. Never interpreted as an empty calendar. |
| Both periods return zero events | Upserts still run; reconciliation is skipped and reported, so a suspected upstream change cannot archive everything at once. |
| Two concurrent syncs | Serialised by `FOR UPDATE`; the loser's guarded statements no-op. |
| Forced sync during a page-load sync | Same lock, same guard. `force` bypasses only the advisory freshness precheck. |
| Mid-transaction failure | Whole transaction rolls back; `last_success_at` never advances, so no partial mirror and no burnt window. |
| Event renamed in Luma | Matched by `luma_id`; the rename propagates unless `name` is pinned. |
| Event deleted in Luma | Archived with reason `missing`, retaining HQ metrics and project links. |
| Auto-archived event reappears | Un-archived automatically. |
| Manually archived event still in Luma | Stays archived. |

## Testing

**Unit — `lib/luma/client.ts`:** multi-page pagination assembles all entries; stops on
`has_more: false`; page cap raises; malformed body raises; empty `entries` array is a
valid empty calendar.

**Unit — `lib/luma/normalize.ts`** (fixtures captured from the live endpoint):
multi-day span detection, calendar-day derivation across a timezone boundary,
URL-only address → `venue: null`, cohost filtering, `featured` tag detection.

**Unit — type guessing:** each keyword rule and the `Other` fallback.

**Integration — pglite, in `tests/hq/`:**

- re-sync updates unpinned fields and preserves pinned ones
- an HQ edit to a pinnable field adds the pin; releasing it restores Luma's value
- `attendance`, `type_id`, `spend`, `leads` are untouched by re-sync
- an event absent from the response is archived with reason `missing`, not deleted
- a **manually** archived event stays archived across a sync in which it is present
- an auto-archived event reappearing in Luma is un-archived
- a failed fetch archives nothing, writes nothing, and leaves `last_success_at`
  unchanged so the next call retries immediately
- a mid-transaction failure rolls back completely, leaving no partial mirror
- a second sync whose `fetchStartedAt` predates a committed success no-ops on all
  three guarded statements
- `force` bypasses the freshness precheck but still serialises
- `deleteEvent` removes an external event and refuses a Luma one
- attribution prefers an active event over an archived one of the same name, and
  falls back to the archived one when no active event matches
- reconciliation adopts a unique name+date match, and reports rather than adopts
  ambiguous ones
- a sync in which both periods return zero events archives nothing

## Out of scope for this spec

The calendar day-number alignment fix (weekday headers were centered while day cells
were left-aligned, and month cards could overflow narrow viewports) was applied
separately as a standalone bug fix.
