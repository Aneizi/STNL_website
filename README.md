Superteam NL's website

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
