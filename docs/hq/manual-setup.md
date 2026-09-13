# HQ manual setup

What the owner has to set up by hand for HQ Captains, public sign-in and the
Colosseum integration, and what is already covered by automated tests.

This file is tracked and it is the authoritative list. It contains variable
**names** only. Never paste a key, secret, token or connection string in here.

Two kinds of check appear under every item:

- **Code-level checks** run in CI and on any developer machine. They use
  synthetic fixtures and stubs, they need no credentials, and they never prove
  that a live service works.
- **Live checks** need your accounts and your setup. An implementer cannot do
  them and must not report them as done.

Missing credentials must never block implementation and must never open a way in.
An unconfigured provider renders an honest "not available yet" state, and
`/api/auth/*` answers 503. A configured but unreachable Telegram breaks Telegram
sign-in only, never email sign-in.

Provider specific notes for your own machine keep living in the gitignored
`setup/hq/` directory, alongside `docs/hq-auth-setup.md`. Those files are not in
git, so they go stale silently. When anything here changes, update your local
copies in `setup/hq/` to match this file.

## Better Auth core

**Status:** Unknown. It cannot be read from the checkout, and it is absent
locally.

**Variables:** `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`.

`BETTER_AUTH_SECRET` must be at least 32 characters and must be its own value,
independent of `HQ_SESSION_SECRET`. `BETTER_AUTH_URL` is the production origin
and must use `https:`.

**Code-level checks:** `tests/hq/member-auth-config.test.ts` covers the origin
rules and the availability flags. The 503 `AUTH_UNAVAILABLE` path is covered.

**Live checks (you):** set both on the Vercel project `stnl-website`, Production
scope, and only when you are ready to open public sign-in.

## Resend email OTP

**Status: Not configured.**

**Variables:** `RESEND_API_KEY`, `EMAIL_FROM`.

`EMAIL_FROM` takes the form `Superteam NL <address@your-verified-domain>`.

**Code-level checks:** Resend is mocked in `tests/hq/member-auth.test.ts`. There
is a delivery failure test that asserts a 503 rather than a silent success.

**Live checks (you):**

1. Verify the sending domain in Resend, including the DNS records it asks for.
2. Create an API key restricted to that domain.
3. Send one real code to a Superteam mailbox and sign in with it.
4. Confirm the five minute expiry wording in the email matches the product copy.

## Telegram login (OIDC)

**Status: Not configured.**

**Variables:** `TELEGRAM_LOGIN_CLIENT_ID`, `TELEGRAM_LOGIN_CLIENT_SECRET`,
`TELEGRAM_BOT_USERNAME`.

**Code-level checks:** synthetic id token, JWKS and token responses in
`tests/hq/member-auth-telegram.test.ts`. No discovery document is fetched
anywhere in the code, so start-up cannot be taken down by Telegram being slow. A
Telegram outage is asserted not to affect email sign-in.

**Live checks (you):**

1. Create the bot.
2. In BotFather, open the mini app for your bot and use **Login Widget**, not the
   older `/setdomain` widget.
3. Add the allowed URLs `https://<your origin>` and
   `https://<your origin>/api/auth/callback/telegram`. Add the staging origin the
   same way if you use one.
4. Copy the client id and client secret into Vercel.
5. Keep the signing algorithm at RS256, and do not request the `phone` scope.
6. Confirm one real sign-in completes end to end.
7. Once a year, or after any Telegram announcement, re-check that Telegram's
   discovery document still lists the endpoints hard coded in
   `lib/hq/telegram-provider.ts`.

## Telegram bot messaging

**Status: Not configured.** Phase 7 work, nothing depends on it before then.

**Variables:** `TELEGRAM_BOT_TOKEN`, plus the webhook URL you register with
Telegram.

**Code-level checks:** none in phases 0 to 2.

**Live checks (you):** later, in phase 7. Permission to message someone is
collected separately from Telegram sign-in, and one never implies the other.

## Colosseum edition mapping

**Status: Not configured, and the correct value is unverified.**

**Variables:** none. The external Colosseum hackathon id and slug are typed into
Admin, under Builder onboarding, and stored in `hq_hackathon_onboarding`.

What is known as of 2026-09-13:

- External Colosseum id 6 is the **Frontier** edition, slug `frontier`. It
  finished, and submissions closed on 2026-05-12. It is **not** the current
  campaign.
- An edition with external id 7 exists, but its project directory is disabled,
  so its name, slug and dates cannot be read from the public API. It is
  plausible, but unproven, that 7 is the World's Fair.
- The `6` that appears inside HQ is an internal key for the HQ hackathon record,
  not Colosseum's id. Do not copy it into the external mapping.

**Code-level checks:** imports are refused while the external id or slug is
unset, and an imported project whose edition does not match both the id and the
slug is rejected.

**Live checks (you):** confirm the World's Fair external id and slug once
Colosseum enables that edition, then set both in Admin before you enable
imports. The mapping cannot be corrected after the first import, so set it once
and set it right.

## Project fallback asset

**Status:** Pending, source located.

**Variables:** none.

The approved image is at `docs/plans/assets/hq-project-fallback.png`, which is
untracked in this checkout. A copy is kept at
`.superpowers/sdd/2026-09-13-hq-captains-and-colosseum/hq-project-fallback.png`.
Phase 3 copies it to `public/images/hq/project-fallback.png`.

**Code-level checks:** T0.2 recorded the path in `docs/hq/contracts.md` so phase
3 does not have to guess it.

**Live checks (you):** none.

## Remove legacy providers

**Status:** Pending task T2.1.

**Variables to delete if they exist:** `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.

There are no public accounts yet, so nothing has to be migrated. Removal is a
matter of deleting provider config, UI and tests.

**Code-level checks:** availability tests assert that Google and GitHub are
absent.

**Live checks (you):** look at the Vercel environment variables for the project
and delete the four names above if any are set.

## Local dev

**Status:** Absent.

**Variables:** everything listed above, in a local `.env.development.local` that
points at a **non production** database. The local Postgres runs on port 5434.

**Code-level checks:** none. Tests must run with `DATABASE_URL` and
`DATABASE_URL_UNPOOLED` unset, so that no test can reach a real database:

```
env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test
```

**Live checks (you):** set `BETTER_AUTH_URL=http://127.0.0.1:3000` for local
sign-in. `localhost` and `127.0.0.1` are not interchangeable here, cookies and
allowed URLs must use the same spelling everywhere.
