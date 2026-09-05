# Hackathon-agnostic HQ

**Date:** 2026-09-04
**Status:** Implemented

## Problem

HQ was built around one campaign. Its settings, milestones, submission gates and
awards described a single edition, and every partner, person, project, event and
link belonged to that one campaign without saying so. The next hackathon would
have meant either wiping the database or seeing last edition's CRM mixed into
this one.

## Goals

1. A hackathon is a first-class record with Colosseum's id, a name and a start and
   end date, archived only by hand.
2. Each hackathon is a separate CRM: partners, people, projects, events, links,
   milestones, awards, finalists, scores, activity, settings and submission gates.
3. Nothing edition-specific is hard-coded. The current edition, Colosseum World's
   Fair (September 14 – October 12, 2026), is data.
4. Every existing record is filed under Colosseum World's Fair by the migration.
5. Signing in lands on a picker: one banner per hackathon. The World's Fair banner
   is its painted background with the wordmark laid over it and the dates beneath.
6. Operators add, rename, re-date and delete hackathons from Admin.

## Non-goals

- Per-hackathon operator accounts or permissions. Every operator sees every
  hackathon.
- Moving a record between hackathons.
- Uploading banner artwork from the UI.

## Data model

`hq_hackathons (id int, slug UNIQUE, name, start_date, end_date, archived_at,
created_at)` with `CHECK (end_date >= start_date)`.

The id is Colosseum's hackathon id, typed in by the operator when an edition is
added, so HQ and Colosseum name an edition the same way: the World's Fair is 6. A
hackathon outside Colosseum takes any unused number. The id never changes.

`archived_at` is set only by hand. An edition's end date passing changes nothing,
because demo day and the wrap-up can run after the hackathon itself closes.
Archiving keeps everything and the edition can still be opened; it moves after the
open editions in the picker and the switcher, and Admin offers Unarchive.

`hackathon_id uuid NOT NULL REFERENCES hq_hackathons ON DELETE CASCADE` on
`hq_partners`, `hq_projects`, `hq_people`, `hq_events`, `hq_links`,
`hq_milestones`, `hq_awards`, `hq_activity`, `hq_submission_gates`,
`hq_settings` and `hq_finalists`. Child tables (gates ticked, notes, members,
exchange items, contacts, link notes, scores) inherit scope through their parent.

Uniqueness moves with the scope:

| Table | Before | After |
|---|---|---|
| `hq_settings` | `PRIMARY KEY (key)` | `PRIMARY KEY (hackathon_id, key)` |
| `hq_submission_gates` | `label UNIQUE` | `UNIQUE (hackathon_id, label)` |
| `hq_finalists` | `position UNIQUE` | `UNIQUE (hackathon_id, position)` |

`hq_finalists.hackathon_id` mirrors the project's and is copied from it by the
insert, so finalist positions can be unique per edition. `hq_project_gates.gate_id`
now cascades on delete, because gates are deletable in Admin.

Shared, deliberately not scoped: users, sessions, login limits, the generic
classifiers (channels, event types, roles, stages, statuses, forecasts, exchange
items) and `hq_luma_sync`, since the Luma calendar is the organisation's.

`slug` is the stable key: it never changes after creation, the seed upserts by it,
and `lib/hq/hackathon-art.ts` maps it to banner artwork under `public/hackathons`.
The World's Fair slug is `colosseum-worlds-fair`.

## Migration

`scripts/hq/upgrades.ts` gains `applyHackathonScoping`, run last:

1. Create `hq_hackathons` if missing (and add `archived_at` if a table predates it).
2. For every scoped table whose `hackathon_id` is missing or still nullable: if any
   such table holds rows and no hackathon exists yet, insert Colosseum World's Fair
   as id 6 (`FIRST_HACKATHON`). Add the column, backfill every row to the earliest
   hackathon (finalists copy their project's), then `SET NOT NULL`. Each table is
   handled on its own so a run interrupted halfway resumes where it stopped.
3. Swap the settings primary key, the gate unique and the finalist unique to their
   per-hackathon forms, renumbering finalist positions per hackathon first.
4. Create the `hackathon_id` indexes. These are not in `schema.sql`: that file
   runs first, and on a pre-hackathon database the column does not exist yet.

The legacy gate rework (Colosseum renames and re-sort) now runs only on databases
without `hackathon_id` on the gates table. Once gates belong to a hackathon they
are that edition's own list.

A fresh database gets no hackathon from the upgrade; `scripts/hq/seed.ts` reads
one from `seed-data.json` (`hackathon: { slug, name, startDate, endDate }`) and
files the seeded gates, settings, milestones and awards under it.

`tests/hq/fixtures/schema-pre-hackathon.sql` is the previous `schema.sql`;
`tests/hq/hackathons.test.ts` applies it, seeds a row in every table, then runs
exactly what `migrate.ts` runs (current `schema.sql`, then the upgrades) and checks
the backfill, the constraints, resumption after a crash, and the cascade.

## Selection

The chosen hackathon lives in an `hq_hackathon` cookie (the integer id only, one
year, httpOnly). `lib/hq/hackathon.ts`:

- `selectedHackathonId()` reads the cookie without a round trip.
- `requireHackathonId()` redirects to `/hq/select` when nothing is chosen.
- `ensureHackathon(row)` redirects when the cookie names a deleted hackathon.
- `requireHackathon()` is the verified variant that create-actions use.

Pages keep their parallel shape: `requireHackathonId()` first (cookie only), then
`Promise.all([requireUser(), getHackathon(id), ...reads(id)])`, then
`ensureHackathon`. No page pays an extra serial round trip for the scope.

Actions that create records take the hackathon from the cookie; actions that
edit a record by id take it from the record itself (they already look the record
up), so the activity feed is always filed with the record. Attaching a partner,
gate, judge or finalist across editions is refused in SQL, not only in the UI.

Every sign-in redirects to `/hq/select`. `/hq` without a choice redirects there
too. The `(app)` layout passes the hackathon list and the selection to the
chrome; each page enforces the scope itself, because layouts do not re-render on
soft navigation.

## Luma events

The mirror is one calendar for every edition. A newly mirrored event is filed
under the hackathon whose dates contain it, otherwise the one whose window is
nearest (the later edition on a tie), decided in the upsert's SQL. Like
`type_id`, `hackathon_id` is HQ-owned after insert: a re-sync never moves an
event. With no hackathon at all the sync fails loudly and writes nothing.

## UI

- `/hq/select` (outside the `(app)` group, no chrome): logo, "Superteam HQ", one
  banner per open hackathon, newest first, each the submit button of a plain form
  posting to `chooseHackathon`; archived editions follow as a compact list. With artwork: the painting as a `next/image`
  background, a shade that lifts the wordmark off the pale sky (thinned on
  hover), the wordmark at 56% width, the date range in small caps beneath.
  Without artwork: a dark typographic banner in the same 3:1 proportion. The
  remembered edition carries a "Current" chip. A database with no hackathon shows
  a form to add the first.
- Chrome: the hackathon name replaces the "Campaign HQ" label and opens a menu of
  every edition (name and dates), plus "All hackathons" and "Manage hackathons".
  Switching stays on the same page, re-scoped, except on a partner detail page,
  which returns to the board.
- Admin: a "Hackathons" card (id shown, inline rename and re-date, Open, Archive
  or Unarchive, two-step delete, add with an id field prefilled with the next free
  number) and a "Submission gates" card (inline rename, two-step delete, add). The
  last hackathon cannot be deleted. A new hackathon copies the current one's
  targets, thresholds, timezone and gates; counters start at zero, the calendar
  window follows its dates, and everything else starts empty.
- `hq:reset` keeps `hq_hackathons`: it empties every edition's CRM, it does not
  remove editions.
