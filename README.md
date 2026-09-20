# Superteam NL

The website for Superteam NL, the Dutch corner of the Solana ecosystem.

There are two sides to it. The public side is what most people see: who we are, what we care about, and a running calendar of events that keeps itself up to date so it never goes stale.

Behind a login sits HQ, the team's own workspace. It is where we track events, partnerships, people, and projects, so the everyday work of running a community lives in one place instead of being scattered across spreadsheets and chat threads.

The app uses Next.js, React, and PostgreSQL, and deploys on Vercel.

## Local development

Use Node.js 24 (the CI version), then run `npm ci`.
Copy the variable names from [the environment example](docs/hq/environment.example)
into a gitignored `.env.development.local` and fill them for your development environment.
`DATABASE_URL` is the pooled application connection; `DATABASE_URL_UNPOOLED` is
the direct connection for migrations and setup. Both use PostgreSQL's wire protocol.
For local PostgreSQL they can point at the same database. Keep staging and
production credentials in separate environment files.

Run `npm run hq:migrate`, then `npm run dev`. The migration command changes the
database named by `DATABASE_URL_UNPOOLED`; check that environment before running it.
See [migration conventions](scripts/hq/migrations/README.md) for adding schema changes
and [seed data](scripts/hq/seed-data.example.json) for optional development setup.

## Validation

```sh
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Tests use disposable in-memory PostgreSQL and clear database environment variables.
CI runs these checks on pushes to `main` and `staging`, and on pull requests.

## HQ maintenance and deployment

[Module contracts](docs/hq/contracts.md) describe the current boundaries and
invariants. [Audit cleanup notes](docs/hq/audit-cleanup.md) record the internal
cleanup, validation scope, and intentionally deferred recommendations.

Apply migrations before deploying code that needs a new schema. The migration
ledger preserves completed history; never edit an applied migration or run
`hq:reset` as part of deployment. Configure the production auth origin, provider
callbacks, secrets, and scheduled job endpoints for the production environment.
The public-account and operator sessions remain separate, even though all runtime
database access shares one connection pool.
