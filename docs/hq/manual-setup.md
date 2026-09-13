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

A check is listed as present only if it exists in this checkout today. Where a
check is still missing, the entry says "none yet" and names the task that has to
add it. Nothing here may describe an unbuilt test as if it already ran, because
that is exactly the false sense of readiness this list exists to prevent.

Missing credentials must never block implementation and must never open a way in.
An unconfigured provider renders an honest "not available yet" state
(`app/hq/(member)/account-form.tsx:121`) and `/api/auth/*` answers 503
(`app/api/auth/[...all]/route.ts:13`). The same rule applies to Telegram: a
configured but unreachable Telegram breaks Telegram sign-in only, never email
sign-in. The provider registers without any network call and
`tests/hq/member-auth-telegram.test.ts` ("keeps email sign-in and existing
sessions working while Telegram is unreachable") asserts it.

Provider specific notes for your own machine keep living in the gitignored
`setup/hq/` directory, which holds `ACTIVATION.md` and `auth.env.template` in
this checkout. The `.gitignore` also reserves `docs/hq-auth-setup.md`, which does
not exist here. None of those files are in git, so they go stale silently. When
anything here changes, update your local copies in `setup/hq/` to match this
file.

## Better Auth core

**Status:** Unknown. It cannot be read from the checkout, and it is absent
locally.

**Variables:** `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`.

`BETTER_AUTH_SECRET` must be at least 32 characters and must be its own value,
independent of `HQ_SESSION_SECRET`. `BETTER_AUTH_URL` is the production origin
and must use `https:`.

**Code-level checks:** `tests/hq/member-auth-config.test.ts` covers the origin
rules, the availability flags and the fact that `HQ_SESSION_SECRET` is not a
fallback for a missing `BETTER_AUTH_SECRET`.

The 503 `AUTH_UNAVAILABLE` response exists in code
(`app/api/auth/[...all]/route.ts:13`, surfaced by
`app/hq/(member)/account-form.tsx:17`), but **no test covers it today**. Whoever
next changes an auth surface should add one.

**Live checks (you):** set both on the Vercel project `stnl-website`, Production
scope, and only when you are ready to open public sign-in.

## Resend email OTP

**Status: Not configured.**

**Variables:** `RESEND_API_KEY`, `EMAIL_FROM`.

`EMAIL_FROM` takes the form `Superteam NL <address@your-verified-domain>`.

**Code-level checks:** Resend is mocked in `tests/hq/member-auth.test.ts:39-49`,
and "does not pretend email delivery succeeded when the sender fails" in the
same file asserts a 503 rather than a silent success.

**Live checks (you):**

1. Verify the sending domain in Resend, including the DNS records it asks for.
2. Create an API key restricted to that domain.
3. Send one real code to a Superteam mailbox and sign in with it.
4. Confirm the five minute expiry wording in the email matches the product copy.

## Telegram login (OIDC)

**Status: Not configured.**

**Variables:** `TELEGRAM_LOGIN_CLIENT_ID`, `TELEGRAM_LOGIN_CLIENT_SECRET`,
`TELEGRAM_BOT_USERNAME` (copy only; it does not gate availability).

**Redirect URL to register:** `<BETTER_AUTH_URL>/api/auth/callback/telegram`,
with `BETTER_AUTH_URL` exactly as set in Vercel (scheme and host, no path). The
provider derives it from that variable at request time; nothing else in the
code names it.

**Code-level checks:** `tests/hq/member-auth-telegram.test.ts` drives the
whole flow through the route handler with a synthetic RS256 key, JWKS and
token endpoint. It asserts the PKCE authorization request, the token exchange
shape, the placeholder account with `emailVerified` false, the identity row,
`currentMember()` admitting the account with `email: null`, replay and forged
tokens refused, the conflict with another account refused before anything is
committed, and that a Telegram outage does not affect email sign-in. Since
task T2.2 it also covers Connect Telegram from an email account (confirmation
step, `/link-social`, callback, audit event), the conflict redirect when the
Telegram account belongs to someone else, the 15 minute session rule on
`/link-social`, `/unlink-account` and the two change-email endpoints, the
refusal to disconnect the last login method, and the account page markup.
Any request to the discovery document fails the suite, so start-up cannot be
taken down by Telegram being slow. `tests/hq/member-auth-config.test.ts`
covers the `telegram` availability flag; `tests/hq/account-form.test.ts`
covers the honest unavailable state on the sign-in page. Until the two
variables are set, the sign-in page shows "Telegram sign-in is not available
yet" and the account page shows the same in place of Connect Telegram.

**Live checks (you):**

1. Create the bot.
2. In BotFather, open the mini app for your bot and use **Login Widget**, not the
   older `/setdomain` widget.
3. Under **Allowed URLs** add the site origin `https://<your origin>` and the
   redirect URL `https://<your origin>/api/auth/callback/telegram`. Add the
   staging origin and its redirect URL the same way if you use one. The
   origin must be the same value as `BETTER_AUTH_URL`.
4. Copy the client id and client secret into Vercel as
   `TELEGRAM_LOGIN_CLIENT_ID` and `TELEGRAM_LOGIN_CLIENT_SECRET`. Set
   `TELEGRAM_BOT_USERNAME` if you want the bot named in copy later.
5. Keep the signing algorithm at RS256 (the provider accepts nothing else),
   and do not request the `phone` scope (the provider never asks for it).
6. Confirm one real sign-in completes end to end. This is also the only check
   of the token exchange against Telegram's real endpoint: the code sends
   `client_secret_basic` plus `client_id` in the body, as Telegram's docs
   show, but no automated test can prove Telegram accepts it.
7. Then confirm Connect Telegram from an email account on `/hq/account`: the
   confirmation step, the Telegram approval, and the "Telegram connected."
   notice. Try it again from a second HQ account with the same Telegram
   account and check it is refused with the "already connected to another HQ
   account" message and nothing moves.
8. Once a year, or after any Telegram announcement, re-check that Telegram's
   discovery document still lists the endpoints hard coded in
   `lib/hq/telegram-provider.ts` (`/auth`, `/token`,
   `/.well-known/jwks.json` under `https://oauth.telegram.org`). The code
   never reads the discovery document on its own.

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

**Code-level checks:** `tests/hq/builders-admin.test.ts` asserts that Admin
refuses to open imports while the external id is null or the slug is empty
("requires a confirmed external mapping before imports ...") and that a mapping
cannot be remapped once a team has been imported ("keeps external IDs separate
and prevents remapping imported teams"). `tests/hq/builder-onboarding.test.ts`
asserts that an import whose edition id or slug does not match is rolled back
whole, and `tests/colosseum-api.test.ts` asserts that `assertProjectHackathon`
requires both the id and the slug.

Not covered: the public action guards at `lib/hq/actions/builders.ts:38,54,69`,
which refuse a preview, a challenge or an import while the mapping is unset, have
no test of their own.

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

**Code-level checks:** none. Task T0.2 recorded the source and target paths in
`docs/hq/contracts.md` so that phase 3 does not have to guess them, but nothing
verifies that either file is present until phase 3 adds the target.

**Live checks (you):** none.

## Remove legacy providers

**Status:** Done in code by task T2.1. The live clean-up below is still yours.

**Variables to delete if they exist:** `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Nothing in
this checkout reads them any more, so leaving them set changes no behaviour;
delete them anyway, so that no stale credential outlives the code that used it.

There were no public accounts, so nothing had to be migrated. Task T2.1 deleted
the provider configuration, the two buttons and their styles and the availability
flags, and turned the tests that asserted the providers worked into tests that
assert they are gone. Email is the only public sign-in method until task T2.2
adds Telegram.

**Code-level checks:** `tests/hq/member-auth-config.test.ts` ("reports exactly
the configured, email and telegram flags" and "gives the removed Google and
GitHub credentials no effect") pins the availability shape to
`{configured, email, telegram}` and asserts that the four variables above change
nothing. `tests/hq/member-auth.test.ts` ("no longer offers google/github
sign-in, whatever the environment holds") stubs all four and asserts that
`/api/auth/sign-in/social` answers 404 `PROVIDER_NOT_FOUND` for both.

**Live checks (you):** look at the Vercel environment variables for the project
and delete the four names above if any are set. The gitignored
`setup/hq/ACTIVATION.md` in your checkout still describes creating a Google
OAuth client and a GitHub OAuth app, and `setup/hq/auth.env.template` still
lists the four variables; both are obsolete, so delete those steps and lines
from your local copies.

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
