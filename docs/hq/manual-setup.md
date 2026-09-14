# HQ manual setup

What the owner has to set up by hand for HQ Captains, public sign-in and the
Colosseum integration, and what is already covered by automated tests.

This file is tracked and it is the authoritative list. It contains variable
**names** only. Never paste a key, secret, token or connection string in here.

**Final for phases 0, 1, 2 and 4.** Every item below is either finished in
code, waiting on the owner, or a live check that only the owner can run.
Phase 4 (Captain invitations, assignments and the leaderboard) added no new
environment variable; it added one live check, item L12 below. The remaining
phases (3 and 5 to 11) will add to this file; nothing in it is removed as
phases land, only moved between the three groups.

## How to read this list

Two kinds of check appear throughout:

- **Code-level checks** run in CI and on any developer machine. They use
  synthetic fixtures and stubs, they need no credentials, and they never prove
  that a live service works.
- **Live checks** need your accounts and your setup. An implementer cannot do
  them and must not report them as done.

A check is listed as present only if it exists in this checkout today. Where a
check is still missing, the entry says so and names what would have to add it.
Nothing here may describe an unbuilt test as if it already ran, because that is
exactly the false sense of readiness this list exists to prevent.

No credential, DNS record, verified domain, bot, external id or successful live
test has been invented anywhere in this repository. Resend and Telegram are
**Not configured**, and they stay that way until you set them up.

Missing credentials must never block implementation and must never open a way in.
An unconfigured provider renders an honest "not available yet" state
(`app/hq/(member)/account-form.tsx`) and `/api/auth/*` answers 503
(`app/api/auth/[...all]/route.ts`). The same rule applies to Telegram: a
configured but unreachable Telegram breaks Telegram sign-in only, never email
sign-in. The provider registers without any network call and
`tests/hq/member-auth-telegram.test.ts` ("keeps email sign-in and existing
sessions working while Telegram is unreachable") asserts it.

## Status at a glance

| Item | Status | Blocks |
|---|---|---|
| Better Auth core (`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`) | Unknown, cannot be read from a checkout | Every public sign-in method, and the cookie `Secure` attribute |
| Resend email OTP | **Not configured** | Email sign-in, sign-up, and the recovery email for Telegram-first accounts |
| Telegram login (OIDC) | **Not configured** | Telegram sign-in and Connect Telegram |
| Legacy Google and GitHub variables | Removed from code, live clean-up outstanding | Nothing. They are dead weight |
| Local `setup/hq/auth.env.template` | Stale, gitignored, must be regenerated | Nothing in production. It misleads the next person who reads it |
| Colosseum edition mapping | **Not configured, and the correct value is unverified** | Phase 3 imports for the current edition |
| Project fallback image | Source located, not yet in `public/` | Phase 3 project presentation |
| Telegram bot messaging | **Not configured** | Phase 7 only. Nothing before then |
| Local dev environment | Absent | Running the app locally. Tests need none of it |

---

# Group 1. Implementation and automated checks completed

Nothing in this group needs you. It is here so that the outstanding work below
is not confused with work that is already done.

- **Telegram identity and sign-in.** The provider, the identity plugin, the
  identity table, Connect and Disconnect Telegram with a confirmation step, the
  15 minute recency window on every endpoint that adds or removes a login
  method, the refusal to remove the last login method, and one Telegram account
  per HQ account enforced at the endpoint, inside the account transaction and by
  a partial unique index. Covered by `tests/hq/member-auth-telegram.test.ts` and
  `tests/hq/telegram-identity-plugin.test.ts`.
- **Email OTP sign-in.** Verification, expiry, attempt limits and
  non-enumerating responses kept from the existing implementation, with the code
  endpoints HQ does not use disabled ahead of the rate limiter. Covered by
  `tests/hq/member-auth.test.ts`.
- **Recovery email for a Telegram-first account**, with the code sent to the new
  address only and a notice to the previous verified address that carries
  neither a code nor the new address. Covered by
  `tests/hq/member-auth-telegram.test.ts`.
- **Bot messaging consent** collected and revoked as its own decision, stored in
  `hq_telegram_bot_consent`. It delivers nothing: see the phase 7 item below.
- **Google and GitHub removed** from the provider configuration, the buttons,
  the styles and the availability flags. Covered by
  `tests/hq/member-auth-config.test.ts` and `tests/hq/account-form.test.ts`.
- **The member shell**, one member route list, the capability-driven menu and
  `/hq/captain`. Covered by `tests/hq/member-routes.test.ts`,
  `tests/hq/member-nav.test.ts` and `tests/hq/member-shell.test.ts`.
- **The rate limit and session-cookie review** for both sign-in methods, with
  one ruling per item and every Change implemented. Recorded in
  `docs/hq/implementation-log.md` under "T2.5 review".
- **Migrations.** Every phase 0 to 2 migration is additive and idempotent, and
  `tests/hq/migration-order.test.ts` applies all of them twice on a fresh
  database and again over a populated fixture, through the statement splitter.
  You do not need a migration window; `hq:migrate` is safe to re-run. The
  phase 4 tables (`hq_captain_invitations`, `hq_captain_invitation_redemptions`,
  `hq_captain_assignments`) are covered by the same test and the same rule.
- **Captain invitations, assignments and the leaderboard.** One-use and
  multi-use invitation links with expiry and capacity, the `/hq/invite/<token>`
  exchange and acceptance flow, the assignment service with its conflict
  checks (a participant cannot Captain their own team), the revocation
  cascade, and a leaderboard visible to Admin and to each Captain that never
  shows a Captain another Captain's project. No new environment variable.
  Covered by the tests named in `docs/hq/implementation-log.md`'s phase 4
  acceptance checklist. **One item in this feature is not code-level
  verifiable and is listed as a live check below: item L12.**

**One known gap in this group.** The 503 `AUTH_UNAVAILABLE` response in
`app/api/auth/[...all]/route.ts`, surfaced by
`app/hq/(member)/account-form.tsx`, has no test of its own. Whoever next
changes an auth surface should add one. It is listed here rather than claimed as
covered.

---

# Group 2. Owner setup actions outstanding

In dependency order. Item 1 decides values that items 2 and 3 need, so do it
first even if you are not ready to open public sign-in.

## 2.1 Better Auth core

**Status:** Unknown. It cannot be read from the checkout, and it is absent
locally.

**Who:** you. **Where:** the Vercel project `stnl-website`, Production scope.

**Variables:** `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`.

**Steps.**

1. Decide the deployment origin for HQ public sign-in. **This is a missing owner
   input.** Nothing in the repository can tell you what it should be, and every
   item below quotes it. Until you fix it, the redirect URL in item 2.3 cannot be
   registered and the Telegram Allowed URLs cannot be entered.
2. Set `BETTER_AUTH_URL` to that origin: scheme and host, no path, no trailing
   slash. It must use `https:`.
3. Generate `BETTER_AUTH_SECRET` as its own value, at least 32 characters. It
   must be independent of `HQ_SESSION_SECRET`; the code refuses to fall back from
   one to the other.

**Non-secret values to copy:** the origin itself, which you will paste again in
items 2.3 and 2.5.

**How to verify.** `BETTER_AUTH_URL` decides three things you can see: whether
`/hq/signin` offers a method at all, the `Secure` attribute and the `__Secure-`
prefix on the session cookie, and the redirect URL Telegram must accept. After
setting it, open `/hq/signin` and confirm the page renders; the cookie check
belongs with the live checks in group 3.

**Unavailable until done:** all public sign-in. Operator login at `/hq/login` is
unaffected and keeps working throughout.

**Code-level checks:** `tests/hq/member-auth-config.test.ts` "requires
independent secrets and an explicit secure production origin" and "marks cookies
Secure exactly when the origin is https, whatever NODE_ENV says".

## 2.2 Resend email OTP

**Status: Not configured.**

**Who:** you. **Where:** Resend, your DNS provider, then Vercel.

**Variables:** `RESEND_API_KEY`, `EMAIL_FROM`.

**Steps.**

1. Verify the sending domain in Resend, including every DNS record it asks for.
2. Create an API key restricted to that domain. Set it as `RESEND_API_KEY`.
3. Set `EMAIL_FROM` in the form `Superteam NL <address@your-verified-domain>`.

**Non-secret values to copy:** the `EMAIL_FROM` display name and address shape
above. The domain is yours to choose; nothing in the repository names one.

**How to verify:** the live checks in group 3, items L1 to L3. Both variables
must be set before email sign-in is advertised at all: the availability flag
requires an API key **and** a sender.

**Unavailable until done:** email sign-in, email sign-up, and Add a recovery
email for a Telegram-first account. Each shows an honest unavailable line rather
than a broken form.

**Code-level checks:** Resend is mocked in `tests/hq/member-auth.test.ts`, and
"does not pretend email delivery succeeded when the sender fails" in the same
file asserts a 503 rather than a silent success.
`tests/hq/member-auth-config.test.ts` "does not advertise email sign-in without
both an API key and a sender" pins the flag.

## 2.3 Telegram login (OIDC)

**Status: Not configured.** Depends on item 2.1.

**Who:** you. **Where:** BotFather in Telegram, then Vercel.

**Variables:** `TELEGRAM_LOGIN_CLIENT_ID`, `TELEGRAM_LOGIN_CLIENT_SECRET`,
`TELEGRAM_BOT_USERNAME` (copy only; it does not gate availability).

**Redirect URL to register:** `<BETTER_AUTH_URL>/api/auth/callback/telegram`,
with `BETTER_AUTH_URL` exactly as set in item 2.1 (scheme and host, no path). The
provider derives it from that variable at request time; nothing else in the code
names it.

**Steps.**

1. Create the bot.
2. In BotFather, open the mini app for your bot and use **Login Widget**, not the
   older `/setdomain` widget.
3. Under **Allowed URLs** add two values: the site origin `https://<your
   origin>` and the redirect URL
   `https://<your origin>/api/auth/callback/telegram`. Add the staging origin and
   its redirect URL the same way if you use one. The origin must be the same
   value as `BETTER_AUTH_URL`.
4. Copy the client id and client secret into Vercel as
   `TELEGRAM_LOGIN_CLIENT_ID` and `TELEGRAM_LOGIN_CLIENT_SECRET`. Set
   `TELEGRAM_BOT_USERNAME` if you want the bot named in copy later.
5. Keep the signing algorithm at RS256; the provider accepts nothing else. Do
   not request the `phone` scope; the provider never asks for it.

**Non-secret values to copy:** the two Allowed URLs in step 3, and the bot
username.

**How to verify:** the live checks in group 3, items L4 to L6. Both credentials
must be set before the Telegram button is live; the bot username alone changes
nothing.

**Unavailable until done:** Telegram sign-in and Connect Telegram. Until the two
credentials are set, `/hq/signin` shows "Telegram sign-in is not available yet"
and `/hq/account` shows the same line in place of Connect Telegram. Email
sign-in is unaffected.

**Two standing cautions.**

- The partial unique index `hq_auth_account_telegram_user_idx` (one Telegram
  account row per user) assumes no account already holds two Telegram rows. That
  is true while Telegram login is unconfigured. If Telegram login was ever live
  on a database before this index existed, check for duplicates before running
  the migration, because `CREATE UNIQUE INDEX` fails on them.
- Once a year, or after any Telegram announcement, re-check that Telegram's
  discovery document still lists the endpoints hard coded in
  `lib/hq/telegram-provider.ts` (`/auth`, `/token` and
  `/.well-known/jwks.json` under `https://oauth.telegram.org`). The code never
  reads the discovery document on its own, by design: a slow Telegram must not be
  able to take start-up down.

**Code-level checks:** `tests/hq/member-auth-telegram.test.ts` drives the whole
flow through the route handler with a synthetic RS256 key, JWKS and token
endpoint. It asserts the PKCE authorization request, the token exchange shape,
the placeholder account with `emailVerified` false, the identity row,
`currentMember()` admitting the account with `email: null`, replay and forged
tokens refused, the conflict with another account refused before anything is
committed, Connect Telegram from an email account through the confirmation step,
the conflict redirect when the Telegram account belongs to someone else, the 15
minute session rule, the refusal to disconnect the last login method, and the
account page markup. Any request to the discovery document fails the suite.
`tests/hq/member-auth-config.test.ts` "advertises Telegram only with both login
credentials, whatever the bot username" covers the availability flag, and
`tests/hq/account-form.test.ts` covers the honest unavailable state.

## 2.4 Remove the legacy provider variables

**Status:** Done in code by task T2.1. The live clean-up is yours.

**Who:** you. **Where:** the Vercel project's environment variables.

**Variables to delete if they exist:** `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.

**Steps.** Open the project's environment variables and delete the four names
above from every scope that has them.

**How to verify.** Nothing in this checkout reads them any more, so there is no
behaviour to test. The point is hygiene: no stale credential should outlive the
code that used it. Revoke the OAuth client and the OAuth app at Google and GitHub
as well, so the credentials are dead at the source.

**Unavailable until done:** nothing. Leaving them set changes no behaviour.

**Background.** There were no public accounts, so nothing had to be migrated.
Task T2.1 deleted the provider configuration, the two buttons and their styles
and the availability flags, and turned the tests that asserted the providers
worked into tests that assert they are gone.

**Code-level checks:** `tests/hq/member-auth-config.test.ts` "reports exactly the
configured, email and telegram flags" and "gives the removed Google and GitHub
credentials no effect" pin the availability shape to
`{configured, email, telegram}` and assert that the four variables above change
nothing. `tests/hq/member-auth.test.ts` "no longer offers google sign-in,
whatever the environment holds" and "no longer offers github sign-in, whatever
the environment holds" stub all four and assert that
`/api/auth/sign-in/social` answers 404 `PROVIDER_NOT_FOUND` for both.

## 2.5 Regenerate the local `setup/hq/auth.env.template`

**Status:** Stale. Depends on items 2.1 to 2.4, because it is a copy of their
variable names.

**Who:** you, on your own machine. **Where:** the gitignored `setup/hq/`
directory, which holds `ACTIVATION.md` and `auth.env.template` in this checkout.

**Steps.**

1. Regenerate `setup/hq/auth.env.template` **without** `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, and
   **with** `TELEGRAM_LOGIN_CLIENT_ID`, `TELEGRAM_LOGIN_CLIENT_SECRET` and
   `TELEGRAM_BOT_USERNAME` beside the existing `RESEND_API_KEY`, `EMAIL_FROM`,
   `BETTER_AUTH_URL` and `BETTER_AUTH_SECRET`. Names and empty values only, the
   way a template should be.
2. Delete the Google OAuth client and GitHub OAuth app steps from
   `setup/hq/ACTIVATION.md` and replace them with the BotFather steps in item
   2.3.

**How to verify.** Read the template back and check that the four legacy names
are gone and the three Telegram names are present.

**Unavailable until done:** nothing in production. The risk is only that the
next person to read those files follows obsolete instructions. Neither file is
in git, so neither goes stale loudly; the `.gitignore` also reserves
`docs/hq-auth-setup.md`, which does not exist here. When anything in this file
changes, update your local copies in `setup/hq/` to match.

## 2.6 Colosseum edition mapping

**Status: Not configured, and the correct value is unverified.**

**Who:** you, with Colosseum. **Where:** HQ Admin, under Builder onboarding.

**Variables:** none. The external Colosseum hackathon id and slug are typed into
Admin and stored in `hq_hackathon_onboarding`. They are never an environment
variable, never a constant and never seeded.

**What is known as of 2026-09-13.**

- External Colosseum id 6 is the **Frontier** edition, slug `frontier`. It
  finished, and submissions closed on 2026-05-12. It is **not** the current
  campaign.
- An edition with external id 7 exists, but its project directory is disabled,
  so its name, slug and dates cannot be read from the public API. It is
  plausible, but unproven, that 7 is the World's Fair.
- The `6` that appears inside HQ is an internal key for the HQ hackathon record,
  not Colosseum's id. Do not copy it into the external mapping.

**Steps.** Confirm the World's Fair external id and slug with Colosseum once
that edition is enabled, then enter both in Admin before you open imports.

**How to verify.** Admin refuses to open imports while the external id is null
or the slug is empty, so the mapping is proved by imports becoming available at
all. Check the id and slug against Colosseum's own page before you save.

**Unavailable until done:** phase 3 Colosseum imports for the current edition. A
"Dutch registrations" view must say "edition not available", never 0.

**One-way door.** The mapping cannot be corrected after the first import, so set
it once and set it right.

**Code-level checks:** `tests/hq/builders-admin.test.ts` "requires a confirmed
external mapping before imports and blocks foreign signup hosts" and "keeps
external IDs separate and prevents remapping imported teams";
`tests/hq/builder-onboarding.test.ts` "updates the current Colosseum link and
slug when recovering the same external project" and the rollback cases;
`tests/colosseum-api.test.ts` "requires the correct hackathon ID and slug".

**Not covered:** the public action guards in `lib/hq/actions/builders.ts` that
refuse a preview, a challenge or an import while the mapping is unset have no
test of their own.

## 2.7 Project fallback image

**Status:** Pending, source located. Phase 3 work.

**Who:** the implementer of phase 3, not you. **Where:** the repository.

**Variables:** none.

**Steps.** The approved image is at `docs/plans/assets/hq-project-fallback.png`,
untracked in this checkout, with a copy at
`.superpowers/sdd/2026-09-13-hq-captains-and-colosseum/hq-project-fallback.png`.
Phase 3 copies it to `public/images/hq/project-fallback.png` and references that
path.

**How to verify.** The target file exists and the project cards render it.

**Unavailable until done:** phase 3 project presentation falls back to nothing.

**Code-level checks:** none, and none are possible until the target exists. Task
T0.2 recorded both paths in `docs/hq/contracts.md` so that phase 3 does not have
to guess them.

## 2.8 Local dev

**Status:** Absent.

**Who:** whoever runs the app locally. **Where:** a local
`.env.development.local`.

**Variables:** everything in items 2.1 to 2.3, pointing at a **non production**
database. The local Postgres runs on port 5434.

**Steps.** Set `BETTER_AUTH_URL=http://127.0.0.1:3000` for local sign-in.
`localhost` and `127.0.0.1` are not interchangeable here: cookies and Allowed
URLs must use the same spelling everywhere. On plain http the session cookie is
correctly not marked `Secure`, which is why local sign-in works at all; that is
only ever true outside production.

**How to verify.** Sign in locally end to end.

**Unavailable until done:** running the app locally. Tests need none of it and
must run with both database variables unset, so that no test can reach a real
database:

```
env -u DATABASE_URL -u DATABASE_URL_UNPOOLED npm test
```

**Code-level checks:** none for the local environment itself.

## 2.9 Telegram bot messaging

**Status: Not configured.** Phase 7 work. Nothing before phase 7 depends on it,
and there is nothing for you to do yet.

**Variables:** `TELEGRAM_BOT_TOKEN`, plus the webhook URL you register with
Telegram.

**What exists today.** The account page collects the decision (the Bot messages
section on `/hq/account`, stored in `hq_telegram_bot_consent` by
`lib/hq/telegram-consent.ts`). `tests/hq/member-auth-telegram.test.ts` asserts
that it is separate from the connection, that declining keeps website access,
and that disconnecting Telegram revokes it. **There is no delivery:** nothing
reads the row to send a message, no chat id is stored, no webhook exists, and no
test claims otherwise.

**Rule that outlives phase 7.** Permission to message someone is collected
separately from Telegram sign-in, and one never implies the other.

---

# Group 3. Live checks still pending

None of these can be run from a checkout, and none of them has been run. Each
names the group 2 item it depends on. Report them as done only after you have
actually seen the result.

## Email, after item 2.2

- **L1.** Send one real code to a Superteam mailbox and sign in with it.
- **L2.** Confirm the five minute expiry wording in the email matches the
  product copy.
- **L3.** Add a recovery email to a Telegram-only test account on `/hq/account`
  and confirm exactly one code arrives, at the **new** address, and that nothing
  arrives anywhere else. Requires item 2.3 as well, since you need a
  Telegram-only account to try it from. The notice to a previous verified
  address when a login email changes is automated-only today, because neither
  a page nor the confirmation action offers Change email to an account that
  already signs in with email (`confirmEmailChange` answers `EMAIL_ALREADY_SET`
  and the endpoint then has no intent to consume);
  `tests/hq/member-auth-telegram.test.ts` "tells the previous verified address,
  once, when the login email changes" asserts that it goes out, carries no code
  and does not name the new address. Nothing is ever sent to the internal
  placeholder address.

## Telegram sign-in, after items 2.1 and 2.3

- **L4.** Confirm one real sign-in completes end to end. This is also the only
  check of the token exchange against Telegram's real endpoint: the code sends
  `client_secret_basic` plus `client_id` in the body, as Telegram's docs show,
  but no automated test can prove Telegram accepts it.
- **L5.** Confirm Connect Telegram from an email account on `/hq/account`: the
  confirmation step, the Telegram approval, and the "Telegram connected."
  notice.
- **L6.** Try Connect Telegram again from a second HQ account with the same
  Telegram account, and check that it is refused with the "already connected to
  another HQ account" message and that nothing moves.

## Session cookies and the browser, after item 2.1

- **L7.** On the deployed https origin, read the `Set-Cookie` line for the
  session and confirm it carries the `__Secure-` prefix, `HttpOnly`, `Secure`
  and `SameSite=Lax`. The rule is pinned by tests on both sign-in paths, but
  only the deployment proves the origin is what you think it is.
- **L8.** Walk the four client flows in a real browser, which no test covers:
  `signIn.social`, `linkSocial`, `unlinkAccount`, and the recovery-email pair
  `requestEmailChange` then `changeEmail`, including the refreshed cookie.
- **L9.** Open a member page at roughly 960px and at 400px and confirm the
  header menu wraps onto its own row and nothing scrolls sideways. The claim
  rests on the CSS and the render tests today.

## Operator login, after any of the above

- **L10.** After each change in group 2, sign in at `/hq/login` with an existing
  admin username and password and confirm it is unchanged. Nothing in phases 0
  to 2 touched `hq_users` or the operator actions, and
  `tests/hq/operator-auth-actions.test.ts` covers them, but this is the check
  that a public sign-in change never quietly reaches the admin side.

## Colosseum, after item 2.6

- **L11.** Confirm the World's Fair external id and slug with Colosseum, and
  check them against Colosseum's own page before saving them in Admin. They
  cannot be corrected after the first import.

## Captain invitation links, no owner setup required

- **L12.** Run `curl -I` against a running `next dev` or `next start` for
  `/hq/invite/<any token>` and for `/hq/invite/continue`, and confirm the
  response carries `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex,
  noarchive`. `tests/hq/invite-config-headers.test.ts` proves the
  `next.config.ts` entry itself is correct; it drives the route handler and
  the page directly, below the layer that actually applies `headers()`, so it
  cannot prove the header lands on the served response. Not run this session.
  Needs no credential and blocks nothing else — the invitation flow works
  without it — but it is the one thing between the code and the plan's
  privacy requirement for this route, so it should be checked once before
  invitation links are sent out for real.
