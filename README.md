Superteam NL's website

## Responsive HQ navigation

Every authenticated HQ page is `force-dynamic`, and Next.js does not prefetch a
dynamic route that has no `loading` boundary — without one, a navbar click holds
the previous page, with no feedback at all, until the destination's Postgres
queries finish. `app/hq/(app)/loading.tsx` is that boundary for the whole group:
measured on a production build, the click paints a skeleton in under 10ms, the
shared chrome stays interactive, and another navigation can interrupt an
in-flight one.

The shell is not *statically* prefetchable, because `app/hq/(app)/layout.tsx`
reads runtime data — `requireUser()` reads cookies and the session row — so each
prefetch renders that layout on the server. Navbar clicks are unaffected: a soft
navigation between sibling routes keeps the layout already on screen and swaps
only the segment below it. What would regress it is a page's data moving up into
a layout, or a new nested layout that awaits: keep runtime reads in pages, or
behind their own `<Suspense>`.

## Hourly Luma mirror

The HQ Events page reads its local Postgres mirror and never waits for Luma
during navigation. `.github/workflows/sync-luma.yml` refreshes that mirror at
minute 17 of every hour; the authenticated refresh button on `/hq/events`
remains available for an immediate pull.

Vercel's Hobby plan only permits native cron jobs once per day, so the hourly
schedule runs on GitHub Actions instead. The public repository's standard
GitHub-hosted runner is free. The workflow authenticates to
`/api/cron/sync-luma` with GitHub's short-lived OIDC token, restricted to this
repository's immutable ID, the workflow file on `main`, and scheduled/manual
workflow events. No shared cron secret or extra environment variable is needed.
