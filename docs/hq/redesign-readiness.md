# Colosseum HQ redesign: testing handoff

19 September 2026, branch `staging` (from `colosseum-hq`).

The redesign is implemented and ready for an isolated testing pass. The final
review fixed reporting drafts changing weeks after a refresh, modal keyboard
focus, clipboard failure feedback and the lint configuration. The owner then
requested deployment: the migration and hosted build passed, and this version is
live at [staging](https://stnl-hq-staging.vercel.app) in deployment
`dpl_BpBkiRjyGhemvv62ix62WJPJ4EW1`. All 19 HTTPS smoke checks passed and the
stable alias points to that deployment. Existing test records were preserved.

## Where Claude stopped

Claude's session `a668214d-048b-4516-85f3-09f5eb42ec96` merged all 17 screen
implementations and completed integration cleanup through `7fbfcaf`. Its next
workflow, `wf_ac434700-688`, attempted 23 final review jobs; all failed at the
usage limit. Its empty findings/coverage arrays were not a completed review.
The `.claude/RESUME.md` checkpoint is from August and is unrelated.

The follow-up review used the handoff HTML, README, implementation log, original
session decisions, current source, migration/auth/reporting tests and local
browser checks. The HTML references resolve several README discrepancies:
People grants Captain access with a button, Notes is an expanded-row field,
Admin opens from the avatar menu, and Demo day opens from Projects.

The original user's recorded choices remain: remove the per-project reporting
panel, keep funnel counts as seed-only values, and verify only the new address
when changing email (with the existing fresh-session and intent checks).

## Fixes in the completion pass

- Team and Captain drafts remember the week in which typing began. A refreshed
  page cannot silently move their text to the next week. A period-change refusal
  refreshes the schedule when another week is open, preserving the draft, and
  the author can explicitly choose **Use current week**.
- Account and late-update modals move focus inside, wrap Tab/Shift+Tab, lock
  background scrolling, close on Escape and return focus to the opening control.
  Late-update week buttons use group semantics matching their pressed states.
- Copying a teammate link says **Copied** only after the clipboard succeeds.
  Denied/unavailable clipboard access leaves the selectable link and an inline
  manual-copy instruction.
- ESLint ignores the exported design prototypes and their bundled runtime.
  Application lint rules are unchanged.
- The implementation/staging/setup documents now describe the current tabs and
  testable controls rather than the removed reporting panels.

## Verification

- **1,807 tests pass across 80 files** (`npm test`, 19 September 2026,
  63.37 seconds), including embedded PostgreSQL migration, authorization,
  account identity, privacy, reporting and UI-state tests.
- `npx tsc --noEmit` and `npm run build` pass. `npm run lint` has zero errors
  and 18 existing warnings in `public/deck/deck-stage.js`. `git diff --check`
  passes.
- Browser: actual built member/operator login pages; unauthenticated Home,
  Account and Captain redirects; operator Projects/Admin redirects; legacy
  `/hq/signin` redirect preserving its destination.
- Browser: actual Home, Team, Captain, Account and Dashboard components with
  synthetic fixtures at 375, 768 and 1280 pixels. No horizontal page overflow;
  Team and Captain main content precedes the aside below the breakpoint.
- Browser: account and late-update dialog initial focus, keyboard wrapping,
  Escape, focus return and background scroll restoration.
- Hosted staging: production build and 19 HTTPS smoke checks pass. Following
  the owner's request to remove the Vercel gate, all checks also pass without
  bypass headers or Vercel cookies. These cover public login access, enabled
  email/Telegram sign-in, uncached anonymous sessions,
  member/operator route guards, legacy redirects and webhook secret checks.
  A cookie-less `/hq` request redirects to member login at `/hq/login`.

Browser fixtures replaced server actions and auth with local mocks. They verify
layout and client behavior, not live provider delivery or authenticated database
requests. The local production build renders provider-unavailable login because
member auth is not configured here. The existing unused-variable warnings in
`public/deck/deck-stage.js` remain outside this change.

## Start the staging test pass

1. Use the separate staging project/database described in
   [staging-environment.md](staging-environment.md). The redesigned version is
   deployed there. The repository's normal Vercel link still points to the main
   project; deployment used a separately linked source snapshot.
2. The staging migration is complete. For future deployment targets, load the
   isolated environment explicitly and run `npm run hq:migrate` against the
   intended database before deploying this checkout. The migration adds
   `hq_projects.high_potential` (with the one-time onboarding backfill) and
   `hq_reporting_entries.counts_toward_completion`, and renames the old liaison
   role to Partner contact. Existing reporting entries retain their legacy
   completion behavior; new Captain/operator notes do not complete a week.
   Use the migration, not reset/reseed, for an existing test database.
3. Open `/hq/login` for members or `/hq/admin/login` for operators at the stable
   staging address. The link is public without Vercel Authentication; the app's
   member/admin sign-in remains required. The deployment smoke
   checks did not send real email or bot messages; test those flows interactively.
4. Exercise email/Telegram login, profile consent, initialize/join, header menu,
   Account email/link/unlink modals, and loss-of-connection errors. Sign-up opens
   **Find your team**; successful team import or joining then opens the **Home
   menu**. Select the hackathon tile there to open the team.
   Captain invitations have a separate path: open the six-character invite
   link, log in or sign up, and accept to reach the Home menu directly. Existing
   long invitation links still work; new ones use six characters.
   A newly accepted Captain sees a welcome popup over the menu with a link to
   the Captain's Den. Okay, Escape, or clicking the backdrop dismisses it; it
   fades out automatically after 10 seconds and does not recur on refresh.
5. With a team and assigned Captain, exercise current/late updates, editing,
   cross-week drafts, settings/contact preferences, private notes and denied
   access from another account. A Captain note must leave the team update due.
6. Exercise Projects import requests/high potential/lead/Captain controls,
   People Captain grants/revocations, Admin reporting dates/materials/reminders,
   and the remaining Events, Partners and Demo day screens.
7. Continue the provider, device, real PostgreSQL concurrency and recovery checks
   in [the owner manual](manual-setup.md#3-live-verification-checklist-for-the-next-session).

## Explicit follow-up: Colosseum activity sync

The owner chose to finish the redesign against the existing backend and defer
importing Colosseum weekly posts/videos. The Team page retains the design's
automatic-activity copy, but no posts/videos importer exists. Existing Colosseum
project/submission refresh does not supply this history. Treat that sentence as
a known product limitation during testing, not a verified working feature.
Implement the importer, or revise the promise, before public release.
