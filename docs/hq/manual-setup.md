# HQ manual setup

What the owner has to set up by hand for HQ Captains, public sign-in and the
Colosseum integration, and what is already covered by automated tests.

This file is tracked and it is the authoritative list. It contains variable
**names** only. Never paste a key, secret, token or connection string in here.

**Current through phase 8.** Every item below is either finished in code,
waiting on the owner, or a live check that only the owner can run. Phase 4
(Captain invitations, assignments and the leaderboard) added no new
environment variable; it added one live check, item L12 below. Phases 3, 5 and
6 (the Colosseum import, weekly reporting and the reporting dashboards) added
no new environment variable either; their setup is the reporting items further
down. **Phase 7 (the Telegram bot) is the first phase since phase 2 to add
variables**: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`, both
server-side only, and both covered by item 2.9, which is rewritten below with
the exact steps. **Phase 8 (the Wednesday reminders and period closure)
adds no environment variable and no secret at all**: the scheduled job
authenticates with a short-lived GitHub OIDC token minted per run, so there is
nothing to store or rotate. What it does need from you is item 2.11, which is
one deploy and one look at a workflow run. The remaining phases (10 and 11;
the owner removed phase 9 and the plan does not renumber around the gap) will
add to this file; nothing in it is removed as phases land, only moved between
the three groups.

Phases 0 to 6 were reviewed on 15 September 2026 and the findings were fixed
on the same branch. Two of those fixes change the database and are applied by
`npm run hq:migrate` like every other schema change: `hq_reporting_pause_intervals`
(the history behind a pause, so lifting one does not turn the weeks it covered
into missed weeks), `hq_project_ownership` (HQ project ownership independent of
a Colosseum snapshot, backfilled from the existing importers) and an `exempt`
column on `hq_reporting_outcomes`. Run the migration before the first deploy
that carries them; nothing else about the deployment changes.

Phase 8 adds one more table and three columns to the same migration:
`hq_telegram_bot_consent.chat_bound_telegram_user_id` (which Telegram account
opened the chat the bot delivers into), `hq_telegram_actions.hackathon_id`
(which edition a bot button is scoped to) and
`hq_reminder_deliveries.next_attempt_at`, all added on 15 September 2026 after
an external review. Plus `hq_reminder_deliveries`
(one row per Captain per week, recording whether that week's reminder was
sent and why not when it was not). Additive and idempotent like the rest, and
covered by the same single `npm run hq:migrate`.

Phase 7 adds four tables and one column to the same migration
(`hq_telegram_updates`, `hq_telegram_actions`, `hq_telegram_drafts`,
`hq_telegram_outgoing`, and `chat_id` on `hq_telegram_bot_consent`), all
additive and all idempotent. The same single `npm run hq:migrate` covers
them. **Run it even if you are not setting the bot up yet:** the tables are
harmless when empty, and running the migration once is simpler than
remembering to run it later.

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
| Colosseum edition mapping | **Not configured**, but the value is verified: id `7`, slug `crypto-worlds-fair` (item 2.6) | Every self-service import: phase 3 answers "Superteam NL has not confirmed this hackathon's Colosseum edition yet" until it is typed into Admin |
| Project fallback image | Done in code; an optional smaller copy is yours if you want it | Nothing |
| Telegram bot (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, the registered webhook) | **Not configured** | The Telegram bot only. The webhook answers 503 and every website surface, weekly reporting included, is unaffected |
| Reporting schedule for this edition (item 2.10) | **Not configured**, and the value is agreed: final period starts `2026-10-05`. Since phase 6 it is set in Admin under Weekly reporting, not in SQL | Nothing breaks without it, but the 5 to 12 October window would be a weekly period plus a stray day instead of one submission-focus period |
| Scheduled reporting jobs (item 2.11) | Code and workflow are in the repository; nothing has run, because they only run from `main` on the deployed site | The Wednesday Captain reminders and automatic period closure. Everything on the website keeps working; a week that ends stays honest either way, because the dashboards compute a missed week live until the job records it |
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

**Status: Not configured. The value is now VERIFIED and is written below —
you still have to type it into Admin.**

**Who:** you, with Colosseum. **Where:** HQ Admin, under Builder onboarding.

**Variables:** none. The external Colosseum hackathon id and slug are typed into
Admin and stored in `hq_hackathon_onboarding`. They are never an environment
variable, never a constant and never seeded.

**What is known as of 2026-09-14.**

- **The current campaign is external Colosseum id `7`, slug
  `crypto-worlds-fair`, name "Crypto World's Fair".** Verified on 2026-09-14
  by reading a live project of that edition through
  `GET /api/project?slug=...&type=HACKATHON`, whose response carries
  `hackathon: { id: 7, name: "Crypto World's Fair", slug: "crypto-worlds-fair" }`.
  This replaces the 2026-09-13 note that 7 was "plausible, but unproven".
- That edition's **project directory is still disabled**, so it does not
  appear in `GET /api/projects/directories` and its projects cannot be
  listed — which is why the detail endpoint, not the directory, is what
  confirmed it. It also means **Colosseum's own** submission deadline
  (`projectSubmissionEndDate`, from the listing envelope) cannot be read yet.
  That is a different thing from **HQ's** hackathon dates, which you already
  set in Admin and which are what reporting periods run on; nothing in HQ
  reads Colosseum's deadline today, and only phase 10 ("a confirmed, on-time
  Colosseum submission satisfies the final reporting period") will.
- External Colosseum id 6 is the **Frontier** edition, slug `frontier`. It
  finished, and submissions closed on 2026-05-12. It is **not** the current
  campaign.
- The `6` that appears inside HQ is an internal key for the HQ hackathon record,
  not Colosseum's id. Do not copy it into the external mapping.

**Steps.** Enter `7` and `crypto-worlds-fair` in Admin, under Builder
onboarding, and tick Enable project imports. Check both against Colosseum's
own page first: the value above is verified but it is still a one-way door,
and HQ deliberately holds no copy of it in code.

**How to verify.** Admin refuses to open imports while the external id is null
or the slug is empty, so the mapping is proved by imports becoming available at
all. Check the id and slug against Colosseum's own page before you save.

**Unavailable until done:** every self-service import. Phase 3 refuses with
its own message — "Superteam NL has not confirmed this hackathon's Colosseum
edition yet" — rather than comparing a project against a null mapping.

**One-way door.** The mapping cannot be corrected after the first import, so set
it once and set it right.

**Code-level checks:** `tests/hq/builders-admin.test.ts` "requires a confirmed
external mapping before imports and blocks foreign signup hosts" and "keeps
external IDs separate and prevents remapping imported teams";
`tests/hq/builder-onboarding.test.ts` "refuses when the edition mapping is
unset rather than comparing against null" and "refuses with reason
wrong_edition and writes nothing"; `tests/colosseum-api.test.ts` "requires the
correct hackathon ID and slug".

## 2.7 Project fallback image

**Status:** Done in code (phase 3). One optional follow-up for you.

**Who:** you, only if you want the optional follow-up. **Where:** the
repository.

**Variables:** none.

**What phase 3 did.** The approved image was copied from
`docs/plans/assets/hq-project-fallback.png` to
`public/images/hq/project-fallback.png` and is referenced through the one
constant `PROJECT_FALLBACK_IMAGE` (`lib/hq/colosseum-snapshot.ts`).
`components/hq/builder-project-image.tsx` renders it when a project has no
Colosseum image and when the source image fails to load, at a contained
aspect ratio, on the team page, the Captain's assignment cards and the Admin
"Imported teams" list.

**The optional follow-up.** The approved file is 1288x816 and **1.1 MB**. It
is served as a static asset and cached after the first load, so this is a
first-paint cost rather than a per-card one, and nothing is broken — but a
smaller copy (say a square export under 60 KB) would be a real improvement on
a phone. Replacing the file at that same path is the whole change; no code
moves. Left to you deliberately rather than re-encoding approved artwork
without being asked.

**How to verify.** `tests/hq/colosseum-snapshot.test.ts` ("the approved
fallback image") asserts the file exists at that path, that the component
falls back on both a missing and a failed image, and that no image proxy or
`remotePatterns` host was added for the Colosseum CDN.

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

## 2.9 The Telegram bot

**Status: Not configured.** Phase 7 built the bot; this item is what makes it
exist in the world. Nothing else in HQ depends on it: with these variables
unset the webhook answers 503 and the website, weekly reporting included, is
completely unaffected.

**Variables:** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`. Both are
server-side only. Neither may be `NEXT_PUBLIC_`, and neither belongs in this
file, in a commit, in a screenshot or in a support message.

There is also `TELEGRAM_API_BASE`, an override for a self-hosted Bot API
server. **Leave it unset.**

**A note on the two Telegram things.** These are not the same as item 2.3.
Item 2.3 is Telegram *login* (`TELEGRAM_LOGIN_CLIENT_ID`,
`TELEGRAM_LOGIN_CLIENT_SECRET`, the Login Widget callback), which is how
somebody signs into HQ in a browser. This item is the *bot*, which is how a
Captain reports from a chat. They can use the same BotFather bot, and doing so
is simpler, but the credentials are different values set up in different
places. Doing one does not do the other.

### What to do, in this order

**1. Create the bot, or reuse the one from item 2.3.** In Telegram, message
`@BotFather`, send `/newbot`, and give it a name and a username ending in
`bot`. BotFather replies with the **bot token**. That token is the credential:
anyone holding it is the bot.

**2. Leave group privacy enabled.** `/setprivacy` → Enable is BotFather's
default and is what you want: with privacy enabled the bot does not receive
ordinary group messages at all. The bot refuses to do reporting in a group
chat regardless (it answers one sentence and shows nothing about any team),
so this is a second line rather than the only one. Do not disable it.

**3. Generate a webhook secret.** Any value of 16 to 256 characters using
`A-Z a-z 0-9 _ -`. Generate it, do not invent it by hand:

```
openssl rand -base64 32 | tr -d '=+/' | cut -c1-48
```

Keep the output somewhere safe for the next two steps. It is a password.

**4. Set both variables in Vercel**, for Production and Preview, as plain
(not public) environment variables:

```
vercel env add TELEGRAM_BOT_TOKEN production
vercel env add TELEGRAM_WEBHOOK_SECRET production
```

Redeploy afterwards, because environment variables are read at runtime by the
deployment that holds them.

**5. Register the webhook with Telegram.** One call, from your own machine.
Substitute your token, your deployed origin and the secret from step 3:

```
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://<your-domain>/api/telegram/webhook",
       "secret_token":"<TELEGRAM_WEBHOOK_SECRET>",
       "allowed_updates":["message","callback_query"],
       "drop_pending_updates":true}'
```

Expect `{"ok":true,"result":true,"description":"Webhook was set"}`.

`allowed_updates` keeps Telegram from sending update types the bot ignores.
`drop_pending_updates` throws away anything queued from before setup; use it
on the first registration only.

**Your shell history now contains the bot token.** Clear it, or run the call
from a shell with history disabled. This is the one step where the credential
is easy to leave lying around.

**6. Check it, with `getWebhookInfo`:**

```
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

Expect your URL, `"has_custom_certificate":false`, `"pending_update_count":0`
and **no** `last_error_message`. A `last_error_message` of "Wrong response from
the webhook: 401 Unauthorized" means the secret in Vercel and the secret you
registered do not match. "503" means the deployment cannot see the variables:
redeploy after adding them.

**7. Run the migration**, if you have not already: `npm run hq:migrate`. The
bot writes to four tables that do not exist until you do.

**8. Say hello.** Open the bot in Telegram and send `/start`. What you should
see depends on the account, and each of these is the bot working correctly:

| Your account | What you get |
|---|---|
| Telegram not connected to any HQ account | An explanation and one Open HQ button. No team, no week, nothing about HQ's contents |
| Connected, bot messages not turned on | A request to turn them on, and a button that does it |
| Connected and permitted, no Captain access | How to get Captain access. No project is named |
| Connected, permitted, a Captain | The menu: My projects, Add update, My notes, Open HQ |

**Rotating the token later.** Set the new value in Vercel, redeploy, then run
`setWebhook` again with the new token and the same secret. Revoke the old token
with BotFather (`/revoke`) once the new one works. Rotating the secret is the
same, without BotFather.

### What exists in code

The account page collects the messaging decision (the Bot messages section on
`/hq/account`, stored in `hq_telegram_bot_consent` by
`lib/hq/telegram-consent.ts`), and phase 7 added the chat id beside it. The bot
itself is `lib/hq/telegram-bot.ts` over `lib/hq/reporting.ts`, the same
reporting service the website writes through, and the webhook is
`app/api/telegram/webhook/route.ts` over `lib/hq/telegram-webhook.ts`.

**Code-level checks (134 cases, none of which needs a credential):**
`tests/hq/telegram-bot.test.ts`, `tests/hq/telegram-bot-store.test.ts`,
`tests/hq/telegram-bot-view.test.ts` and `tests/hq/telegram-webhook.test.ts`.
They cover the identity binding, the three gates, sensitive notes, duplicate
presses and webhook retries, stale buttons after reassignment, revocation and
unlinking, expired drafts, escaping and the delivery outcomes, plus the
failure cases an external review found on 15 September 2026: an interrupted
save that has to be finished by Telegram's retry, a save and its confirmation
rolled back together, a Save pressed on a preview that has since been
replaced, two drains of the outgoing queue running at once, a queued message
whose recipient has since turned messaging off, and a note long enough to
need more than one Telegram message. They run against a real schema with only
the Telegram transport stubbed. **None of them is evidence that a live bot
works**, which is what the live checks below are for.

**Rules that outlive this item.** Permission to message someone is collected
separately from Telegram sign-in, and one never implies the other. The bot
never acquires a permission of its own: it reads the identity, the messaging
decision, the Captain capability and the assignment on every single update.

---

# Group 3. Live checks still pending

None of these can be run from a checkout, and none of them has been run. Each
names the group 2 item it depends on. Report them as done only after you have
actually seen the result.

Phase 7 added eight: **L15 to L22**, in "The Telegram bot, after item 2.9" at
the end of this file. Phase 8 added five: **L23 to L27**, in "The scheduled
reporting jobs, after item 2.11", also at the end. L11 and L13 are done;
everything else here is pending.

## 2.10 Reporting schedule for this edition

**Status:** Not configured. One row, one value, and the value is already
agreed.

**Who:** you. **Where:** **Admin, under Weekly reporting** (the panel below
Captain leaderboard), for the edition you have selected. Phase 6 put this on
screen, so the SQL below is now only a reference for what the fields write.

**Variables:** none. This is edition data, not configuration in an
environment.

**Why it matters.** Phase 5 generates the reporting periods from the
edition's own record: `hq_hackathons.start_date` and `end_date` (already set
to 14 September and 12 October 2026 in Admin) with the campaign timezone from
`hq_settings.timezone` (Europe/Amsterdam). Those alone give five weekly
periods, the last of which is 12 October on its own. The agreed schedule is
four periods, the last running **5 to 12 October as a submission-focus
window**, and the setting that produces it is
`hq_reporting_config.final_period_start_date = 2026-10-05`. Nothing is broken
without the row — an edition with no reporting configuration still reports
weekly — but the final period will not be the agreed one.

**What to set.** In Admin, under Weekly reporting: set **Final submission
period starts** to 5 October 2026 and press **Save reporting settings**. Then
read the panel's "Before you change the dates" line and press **Apply the
hackathon dates to the weeks**, which is what writes the periods; the panel
names any week it will not move because teams have already reported against
it, before you press it.

If the panel says the change would leave a gap or an overlap between the
weeks, nothing is written at all: a week that already holds updates keeps its
own dates, and if the weeks around it would move away from it there would be a
day belonging to no week (or to two), which an update written on that day
would have nowhere to go. The panel names the two weeks and the days between
them. Change the hackathon dates again rather than trying to apply it twice.

The same row, as SQL, for reference:

```sql
INSERT INTO hq_reporting_config (hackathon_id, final_period_start_date)
VALUES (<the World's Fair hq_hackathons.id>, '2026-10-05')
ON CONFLICT (hackathon_id) DO UPDATE SET final_period_start_date = EXCLUDED.final_period_start_date, updated_at = now();
```

Two optional columns on the same row, both also on that Admin panel:

- `official_submission_deadline` — set this **only if Colosseum's own cutoff
  turns out to be earlier** than 13 October 00:00 Europe/Amsterdam, which is
  where HQ's own window ends. It is what an on-time confirmed submission is
  measured against when deciding whether it satisfies the final period. It is
  not readable from Colosseum today: that edition's project directory is still
  disabled (item 2.6), so `projectSubmissionEndDate` cannot be fetched. Leave
  it NULL until you know the real value. HQ's reporting window never changes
  the external deadline either way.

  Type it as the clock reads **in the campaign timezone**, which the field's
  own label names: since 15 September 2026 the form both shows and reads the
  value in that zone rather than in whichever zone the server happens to run
  in, so 23:59 on 12 October means 23:59 in Amsterdam wherever it is entered
  from. The SQL above is the exception, as SQL always is: a `timestamptz`
  literal there needs its own offset, for example `'2026-10-12 23:59+02'`.
- `nudge_weekday` and `nudge_time` — the **Reminder day** and **Reminder time**
  fields, defaulting to Wednesday and 12:00 local, which is the agreed
  reminder slot. Change them here rather than in bot code: phase 8's job reads
  this row, and a change takes effect for every week whose reminder has not
  been recorded yet. Changing them does not resend a reminder that already
  went out.

**How to verify.** The Admin panel lists the stored weeks directly: expect
"Week 1: 14 to 20 September", "Week 2: 21 to 27 September", "Week 3: 28
September to 4 October" and "Week 4: 5 to 12 October (final submission
period)". The same in psql, if you would rather:

```sql
SELECT sequence, mode, start_date, end_date, nudge_at FROM hq_reporting_periods
WHERE hackathon_id = <id> ORDER BY sequence;
```

Expect exactly four rows: three `weekly` (14-20 September, 21-27 September,
28 September-4 October) and one `submission` (5-12 October), with nudges on
16, 23 and 30 September and 7 October. `tests/hq/reporting-periods.test.ts`
asserts the same table without a database.

**One thing to know before changing these dates later.** Phase 5 will not
silently relabel a week people have already reported in: a period that holds
an entry or an outcome, or that has been closed, is left alone and reported as
a conflict instead. Phase 6's Admin screen shows those conflicts before the
change; today, a date edit simply leaves such periods as they are.

## 2.11 The scheduled reporting jobs

**Status:** the code, the endpoint and the workflow are in this repository and
nothing has run. They only run from `main`, on the deployed site, so this item
is a merge, a deploy, a migration and one look at a workflow run.

**Variables: none, and no secret of any kind.** This is the point of the
approach. GitHub mints a short-lived OIDC token for each workflow run and
`/api/cron/hq-jobs` verifies it against GitHub's public keys, so there is
nothing to paste into Vercel, nothing to rotate and nothing that can leak from
a log. It is the same pattern the Luma sync has used since before this plan,
with its own audience and its own workflow file so neither job's identity
opens the other's endpoint.

**What it does.** Every half hour it asks the database what is due right now:
Wednesday reminders to Captains with teams that still owe an update, closure
of any reporting week whose end has passed, and the retention sweep of expired
bot drafts and old job rows. Nothing depends on one exact invocation landing
at noon: a run that is late, delayed or skipped entirely catches up on the
next one, as long as the reporting week is still open.

### What has to be true first

1. **`npm run hq:migrate` has been run** against production, so
   `hq_reminder_deliveries` exists. The job writes there on every pass.
2. **Item 2.10 is done.** With no stored reporting periods there is no nudge
   instant and nothing is ever due.
3. **Item 2.9 is done**, if you want messages actually delivered. Without the
   bot the job still decides and records every reminder, and Admin shows them
   as waiting to send; the moment the bot is configured, the waiting ones go
   out on the next pass.
4. **This branch is merged to `main` and deployed.** The claim policy pins the
   repository, its numeric id, its owner id, the ref `refs/heads/main` and the
   workflow file `.github/workflows/hq-jobs.yml`. A run from a branch, a fork
   or a renamed repository is refused with 401 by design.

### What to do, in this order

**1. Check the production URL in the workflow.** `.github/workflows/hq-jobs.yml`
calls `https://nl.superteam.fun/api/cron/hq-jobs`. If the production domain is
anything else, change that line; it is the only address in the file.

**2. Merge and deploy.** Scheduled workflows only run from the default branch,
and the endpoint only exists on a deployment that carries it.

**3. Check that GitHub Actions is enabled for the repository**, under
Settings, Actions, General. Note that GitHub disables `schedule` triggers on a
repository with no activity for about sixty days and emails the owner when it
does; if reminders ever stop for no visible reason, that is the first thing to
look at.

**4. Run it once by hand.** Actions, "HQ reporting jobs", Run workflow. That
is the authenticated manual retry, and it is also the check: the run should
succeed and its log should end with a small JSON object of counts. It carries
no Captain, no chat id, no project name and no update text by construction.

**5. Confirm from inside HQ.** Admin, Weekly reporting, under **Wednesday
Captain reminders**. Before the first Wednesday it will say no reminder has
been recorded yet, which is correct. The **Run the reminder and closure job
now** button on that panel is the same pass, triggered by your own admin
session, for when you would rather not wait for the schedule or go to GitHub.

**6. On the first Wednesday after noon Amsterdam time**, open that panel again
and read the list. Each row names a Captain, the week, how many of their teams
were outstanding, and what happened to the message.

### Two things that are deliberately not offered

- **There is no per-Captain "send it again" button.** A message Telegram
  refused permanently, or that ran out of attempts, stays refused with its
  reason on screen. Re-queueing one by hand is exactly how an automated
  reminder turns into spam, so what you get instead is the reason and the
  ability to fix the underlying problem for next week.
- **There is no Vercel Cron entry**, and none should be added. The
  GitHub Actions route needs no stored secret and no plan-tier cron
  allowance, and it is the pattern already in use for the Luma sync. Two
  schedulers on the same endpoint would be harmless (every pass is
  idempotent) and would only double the noise.

### One Vercel setting to be aware of

If Deployment Protection (Vercel Authentication) is ever turned on for
production, it sits in front of every route including this one, and the
workflow will start failing with an HTML login page instead of JSON. The Luma
sync would fail the same way, so if both stop at once, that is where to look.

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

- **L11. Done, 2026-09-14.** The World's Fair external id and slug are `7` and
  `crypto-worlds-fair`, read from a live project of that edition through the
  detail endpoint. Still check them against Colosseum's own page before saving
  in Admin: the mapping cannot be corrected after the first import.

## Colosseum submission signal, after real projects exist

- **L13. Done, 2026-09-14.** The submitted/unsubmitted pair was observed
  through the unauthenticated detail endpoint: an in-flight Crypto World's
  Fair project returned `"submittedAt": null` (the field present and null) and
  a finished Frontier project returned a real timestamp.
  `DRAFT_SIGNAL_CONFIRMED` in `lib/hq/colosseum-snapshot.ts` is now `true`, so
  a checked project with no submission shows a red **Not submitted**. One
  caveat recorded at the constant: the two projects are from different
  editions, because the current edition's disabled directory makes a
  same-edition pair unobtainable. Set it back to `false` if a project is ever
  seen to have submitted while reporting a null `submittedAt`.
  **Note what this means during the hackathon:** until Colosseum opens
  submissions for this edition, every imported team correctly reads "Not
  submitted". That is accurate, not a fault.

## Team join links, no owner setup required

- **L14.** The same `curl -I` check as L12 below, for `/hq/join/<any code>`:
  confirm the response carries `Referrer-Policy: no-referrer` and
  `X-Robots-Tag: noindex, noarchive`. A join link carries a bearer code in its
  path, exactly like a Captain invitation link.
  `tests/hq/invite-config-headers.test.ts` proves the `next.config.ts` entry;
  it cannot prove the served header. Not run this session.

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

## The Telegram bot, after item 2.9

None of these has been run, and none of them can be run from a checkout: there
is no bot, no token and no webhook. Run them in order; each one tells you
something the one before it does not.

- **L15.** `getWebhookInfo` returns your URL with no `last_error_message` and
  `pending_update_count` at 0. This is the only check that proves the secret
  in Vercel and the secret you gave `setWebhook` are the same value. A 401
  there means they are not.
- **L16.** From a Telegram account that is **not** connected to any HQ
  account, send `/start`. Expect the explanation and one Open HQ button, and
  confirm that no team name, week or status appears. This is the check that
  the bot exposes nothing to a stranger who finds it.
- **L17.** From a connected Captain account with bot messages turned **off**,
  send `/start`, press Turn on bot messages, then confirm on `/hq/account`
  that the Bot messages setting now reads as on. This proves the two facts are
  separate and that the bot can join them only with the person's press.
- **L18.** As a Captain, add an update end to end: `/start`, Add update, pick
  a team, type one sentence, check the preview says "Shared with the team",
  press Save. Then open `/hq/captain` in a browser and confirm the same
  update is there, that the week reads **Updated**, and that the entry shows
  as coming from Telegram. This is the plan's "HQ and bot create/edit
  operations have identical behavior", checked against a real chat rather
  than a stub.
- **L19.** Repeat L18, but press Make it sensitive before saving. Then sign in
  as a member of that team and confirm the team page shows the week as
  Updated and **shows no note, no preview and no count**. This is the privacy
  contract's most load-bearing line, and it is worth seeing with your own
  eyes once.
- **L20.** Block the bot in Telegram, then have somebody save an update on
  that Captain's team from the website, and confirm that the Captain's access
  to `/hq/captain` is completely unaffected. Unblock afterwards. The plan
  requires that a blocked bot never costs somebody their website access.

- **L21.** Write an update long enough to need two Telegram messages (a few
  thousand characters), and confirm the preview arrives complete, with the
  "Shared with the team" line still at the end and the Save button under it.
  Then save it and confirm the whole text is on `/hq/captain`.
- **L22.** Prepare a preview for one team, then without saving it prepare a
  preview for a second team, then scroll back and press Save on the first.
  Expect "That button is no longer good", and confirm afterwards that neither
  team received an update. This is the one failure a stubbed test can only
  approximate.

**One thing to expect and not be alarmed by.** A Captain who is also on the
roster of a team they captain is not offered the sensitive option for that
team. That is the rule working: a Captain cannot use the capability to hide an
update from their own teammates.

**If something goes wrong.** `hq_telegram_updates` records every update the
deployment accepted and how it ended; `hq_telegram_outgoing` records every
message the bot tried to send, the attempt count, a skip reason and Telegram's
own error text. Neither table stores the text of anybody's update. Those two
are the first place to look, before the Vercel logs.

## The scheduled reporting jobs, after item 2.11

None of these can be run from a checkout. Each needs the workflow actually
running against the deployed site, and L24 to L26 additionally need item 2.9,
because they are about a message arriving in a real chat.

- **L23.** Run the workflow by hand (Actions, "HQ reporting jobs", Run
  workflow) and confirm it succeeds and returns a JSON object of counts.
  Then read the run's log and confirm it contains **no Captain name, no chat
  id, no project name and no update text**. This is the one check that the
  endpoint's response shape holds in the real world; everything else about
  the job is asserted in `tests/hq/jobs.test.ts`.
- **L24.** On the first Wednesday after 12:00 Amsterdam time, confirm that a
  Captain with an outstanding team receives exactly one message, that it names
  only their own outstanding teams, and that it carries no note text and no
  mention of a sensitive note. Then confirm in Admin, Weekly reporting, that
  the row for that Captain reads **Sent**.
- **L25.** Before the same Wednesday, have every team of a second Captain post
  its update. Confirm that Captain receives **nothing**, and that Admin shows
  their row as **Not sent** because every assigned team had already updated.
  This is the plan's "if all projects have updated since the job was queued,
  cancel the message", seen end to end.
- **L26.** Press the reminder's **Add update** button in Telegram and confirm
  it opens the bot's team list and that saving from there marks the week
  Updated on `/hq/captain`. Then press the same button again the following
  day and confirm it answers "That button is no longer good" rather than doing
  anything, which is the 24 hour expiry working.
- **L27.** On the Monday after a reporting week ends, confirm in Admin,
  Weekly reporting, that the week now reads **Closed**, and that a team which
  did not update still reads as a missed week after somebody adds a late
  entry to it. The late entry should be visible and labelled late; the missed
  week should not change.

**If reminders stop arriving.** Look in this order: the Actions tab (a
disabled schedule after sixty days of repository inactivity is the most likely
cause, and GitHub emails about it); Admin, Weekly reporting, where every
decision the job made is recorded with its reason; then
`hq_telegram_outgoing`, which records every message the bot tried to send, the
attempt count, a skip reason and Telegram's own error text. None of those
three stores the text of anybody's update.
