# Colosseum response fixtures

Structural fixtures for the public Colosseum API. Field names, types and
nullability were observed on 2026-09-13 through a small number of bounded,
read-only requests against `https://api.colosseum.com`. **Every value that could
describe a person, a team or a project is invented.** Nothing here is a copy of a
real project, roster, handle, display name, avatar or description, and no id
matches a real project.

Rules for anyone editing these files:

1. Keep the key sets and the types. They are the observed contract.
2. Never paste a real project, username, display name, avatar URL or project id
   into a fixture, not even temporarily while debugging.
3. Invented projects use the `Tulip Ledger` / `Orchid Relay` / `Windmill Vault`
   family, invented people use `fictional_builder_N`, and invented media live on
   `https://static.narrative-violation.com/fixtures/...`.

## Files

### `directories.json`

One page of `GET /api/projects/directories`. The response is a single
`hackathons` array with `id`, `name`, `slug`, `phase`, `landingPageUrl` and
`emoji`. No dates are returned by this endpoint.

### `listing.json`

One page of `GET /api/projects`, which needs bracket encoded array parameters
(`hackathonIds[]=...`). The envelope carries `projects`, `hackathons`, `offset`,
`hasMore`, `seed`, `sortApplied`, `directionApplied` and `totalCount`. A listing
row has the same key set as the `project` object of the detail endpoint. The
`hackathons` block is richer than `directories.json` and is the only place the
submission window appears, so `projectSubmissionEndDate` is the value to compare
a project's `submittedAt` against.

Two rows are included so that paging and diffing logic has more than one id to
work with. Both rows are submitted, which matches the live directory: it lists
submitted projects of editions whose directory is enabled, and nothing else.

### `detail.json`

Two top level entries for `GET /api/project?slug=...&type=HACKATHON`:

- `submitted`: the observed happy path. `project.submittedAt` is set and
  `projectCompletion.isComplete` is `true` with an empty `fieldErrors` array.
- `unsubmitted`: **a structural assumption, unverified against a live draft.**
  No unsubmitted or draft project was reachable through the public API, so this
  entry models what the response is assumed to look like: `submittedAt: null`
  and `projectCompletion.isComplete: false` with a non empty `fieldErrors`
  array. Treat it as a shape to code defensively against, never as evidence.
  In particular the element type of `fieldErrors` is unverified, because only an
  empty array was ever observed. Code must not depend on the elements being
  strings.

`project.submittedAt` is the official submission signal.
`projectCompletion.isComplete` is a readiness diagnostic and must never drive
a "Submitted" badge. It was described here as "returned only by the detail
endpoint"; the 2026-09-14 re-check found the public detail endpoint does not
return it at all (finding 3 above).

Neither field is parsed by `lib/colosseum-api.ts` today. Both survive inside the
retained `raw` snapshot because the zod object is not strict.

### `errors.json`

Observed error envelopes, keyed by case, each with the HTTP `status` and the
response `body`. The envelope is `{ message, code, known }` plus an optional
`data.issues` array for validation failures. The messages are kept as observed
because an adapter may need to tell "directory disabled" apart from "unknown
edition", and the current client discards error bodies and collapses every non
2xx other than 404 and 429 to `UNAVAILABLE`.

No rate limit response was observed, so there is no 429 body here. The client
maps HTTP 429 to `RATE_LIMITED` without reading the body, and real thresholds are
unknown.

## Re-checked live on 2026-09-14 (phase 3)

A second round of bounded, read-only, unauthenticated requests. **No value
below was copied into a fixture**; only the structural findings are recorded.
Five of them change what the code has to do, and all five are handled.

1. **`sort` is now REQUIRED on `GET /api/projects`.** Omitting it answers 400
   `BAD_REQUEST`, `"Invalid discriminator value. Expected 'RANDOM' | 'NAME'"`.
   The 2026-09-13 note said only that sorting *is* `NAME` or `RANDOM`;
   `sortApplied` in `listing.json` was the applied value, not evidence the
   parameter was optional. `fetchEditionSubmissionWindow` sends `sort=NAME`.
2. **A listing row's `slug` is not always a slug.** A real Frontier project
   carries `""or""or`, which `slugSchema` rejects. Validating listing rows
   would therefore let one pathological project destroy the whole edition's
   submission window, so `listingSchema.projects` is `z.unknown()`: the window
   read never looks at a row. The **detail** endpoint keeps strict validation,
   because that is what HQ actually imports from.
3. **`projectCompletion` is NOT returned by the public detail endpoint.**
   Neither of the two live projects read on 2026-09-14 carried it, though
   `detail.json` has it and the note below claimed the detail endpoint returns
   it. It is presumably owner-authenticated. The schema already had it
   `nullish`, so nothing breaks — but in practice `completion_is_complete` is
   always NULL, and the "Colosseum readiness" line never renders. The fixture
   keeps the block as a shape to stay defensive against.
4. **The detail response carries a top-level `presentation` block**, a second
   copy of the project fields plus a `revision` hash, and team members carry
   `avatarPresetId`, `bio` and `publicRole` alongside the known keys. All
   survive unread inside the retained `raw` snapshot. Worth knowing:
   **`avatarUrl` was null for every member observed** — the picture is the
   preset id — so `hq_project_members.avatar_url` is usually NULL in practice.
5. **The submitted/unsubmitted pair was finally observed**, which is what
   `DRAFT_SIGNAL_CONFIRMED` was waiting for. An in-flight Crypto World's Fair
   project returned `"submittedAt": null` (present, not absent) and a finished
   Frontier project returned a real timestamp, both through the same
   unauthenticated detail endpoint. `detail.json`'s `unsubmitted` entry is
   therefore no longer only a structural assumption about that one field; the
   rest of that entry still is.

**And the big one: external edition 7 is the current campaign.** A live
project of that edition carries
`hackathon: { id: 7, name: "Crypto World's Fair", slug: "crypto-worlds-fair" }`.
Edition 7 is still absent from `GET /api/projects/directories` (that endpoint
lists enabled directories only), so the detail endpoint is what confirms it.
This does **not** change the standing rule: the mapping stays operator data,
typed into Admin, never seeded and never a constant.

## Two notes about the values

**Edition 6 with slug `frontier`.** That pair is Colosseum's finished Frontier
edition. It appears in these fixtures only to exercise the edition match check
(`assertProjectHackathon`). It is **not** the campaign's external mapping. The
`6` used inside HQ is an internal key, the external Colosseum id for the current
campaign is still unknown, and it must never be seeded or hard coded. See
`docs/hq/manual-setup.md`.

**`Fictional_Builder_2` is deliberately mixed case** while the same person's
comment author name is lower case. Roster and comment author matching is case
insensitive, and the fixtures keep a case mismatch so tests exercise it.
