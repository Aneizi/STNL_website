# HQ owner setup and testing handoff

Updated 15 September 2026 after the integrated review of phases 0–8 and 10.
Phase 9 is removed. This is the current setup guide; older implementation-log
entries describe the state at the time they were written.

**Staging created on 16 September 2026:** follow the
[staging access and next-test instructions](staging-environment.md) for the
deployed test environment and the remaining owner actions. The preparation and
activation reference below remains useful for later production setup.

**Team flow update, 16 September:** the new teammate-selection and shared-link
flow is migrated and deployed to staging. Existing memberships, People records
and older teammate links are preserved. For a later environment, run
`npm run hq:migrate` before deploying this version.

For a new environment, do the preparation below before creating it. The
integrated code review did not deploy or migrate a live database; the later
authorized staging deployment and its checks are recorded in the linked handoff.
Real email delivery, Telegram login and full device testing remain pending.

## 1. Prepare now, in this order

1. **Choose a stable HTTPS address for the test environment.** Record the
   intended production address separately. The scheduler currently targets
   `https://nl.superteam.fun`; confirm that this remains the production origin.
   You can reserve the staging name now and attach it when we create the environment.
2. **Verify an email sending domain in Resend** and create its sending key
   (item 2.2). DNS verification can take time, so start here.
3. **Create a separate Telegram bot for testing**, and optionally prepare the
   production bot too. Configure each bot's login credentials and Allowed URLs
   (item 2.3). A bot has one webhook destination; sharing it between staging and
   production redirects real traffic when the webhook changes.
4. **Generate independent auth and webhook secrets** and store them with the
   provider credentials in your password manager or protected deployment
   settings. Use the variable inventory in item 2.5. Keep staging values separate.
5. **Confirm the hackathon facts**: dates, timezone, external Colosseum mapping,
   actual submission deadline, and which submission materials are required or
   optional (items 2.6, 2.10 and 2.12). These are entered in Admin after deployment.
6. **Confirm database access and recovery**: identify the Neon project, its
   backup/restore window and who can create an isolated branch. Do not run the
   migration against production during this preparation.
7. **Return with the non-secret answers**: staging origin, production origin,
   sending domain/address, test bot username, where the credentials are stored,
   and the confirmed deadline/material requirements. Tell Codex to create the
   test environment. Do not paste credentials into the conversation.

The remaining sections give the exact settings and the later activation order.
You do not need to create the test environment yourself to finish preparation.

## 2. Configuration reference

### 2.1 Better Auth core

**Where:** the deployment's server environment variables.

- `BETTER_AUTH_URL`: this deployment's origin, such as
  `https://hq-test.example.com`, with no path, query or fragment. Use HTTPS.
- `BETTER_AUTH_SECRET`: an independent random value of at least 32 characters.
  Generate it with `openssl rand -hex 32` and store the output privately.
- Preserve the existing production `HQ_SESSION_SECRET`, operator accounts and
  credentials. Staging uses its own secret and synthetic operator account.
- `DATABASE_URL`: the selected environment's pooled PostgreSQL runtime URL.

**Check later:** `/hq/login` renders; authenticated cookies are Secure and
HttpOnly; operator login at `/hq/admin/login` works. A missing core
setting disables public authentication. It does not replace operator login.

### 2.2 Resend email OTP

**Where:** Resend, DNS, then the deployment's server environment variables.

1. Add your chosen sending domain in Resend. Install the SPF/DKIM records it
   gives you and wait for verification. Use the exact values from your account.
2. Create a sending key restricted to that domain; save it as `RESEND_API_KEY`.
3. Set `EMAIL_FROM`, for example `Superteam NL <hq@your-verified-domain>`.
4. Use separate staging and production keys so either can be revoked independently.

Both variables are needed before email login is offered. They also power Add a
recovery email for Telegram-first accounts. Domain verification alone does not
prove delivery; run L1–L3 below after the test deployment exists.
[Resend domain setup](https://resend.com/docs/dashboard/domains/introduction).

**Owner's chosen sender: `noreply@nl.superteam.fun`.** Verify exactly
`nl.superteam.fun` in Resend. The DNS is managed by someone else: send that
administrator Resend's generated sending-record table (type, name, value and
any MX priority). They need the DNS records, not your API key. Once Verified,
set `EMAIL_FROM="Superteam NL <noreply@nl.superteam.fun>"`. Sending from this
address does not require creating a mailbox or enabling inbound email.

For preparation, store the key privately after `RESEND_API_KEY=` in the
gitignored root file `.env.hq-staging.local`; store the `EMAIL_FROM` value there
too. These values will be loaded explicitly when the isolated test environment
is created. Next does not automatically load this custom-named file.

While waiting, single-inbox testing can use
`EMAIL_FROM="Superteam NL <onboarding@resend.dev>"`. Resend limits that default
sender to the email address associated with your Resend account; it cannot
support other people's login tests or public signup.
[Default test sender restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

### 2.3 Telegram login (OIDC)

**Where:** [BotFather](https://t.me/BotFather), then server environment variables.

1. Create the test bot with `/newbot`; save its bot token privately for item 2.9.
2. Open BotFather's mini app, select this bot, then **Login Widget**. If you see
   a single **Enter URL** field and **Switch to OpenID Connect Login**, click
   that switch first to open the OIDC settings used by HQ.
3. Add each URL to its matching field, without a trailing slash:
   - **Redirect URIs:** `https://<test-origin>/api/auth/callback/telegram`
   - **Trusted Origins:** `https://<test-origin>`
   - Leave **Native Login** empty; HQ uses browser login.
4. Copy its Client ID into `TELEGRAM_LOGIN_CLIENT_ID` and Client Secret into
   `TELEGRAM_LOGIN_CLIENT_SECRET`. These are distinct from the bot token.
5. Set `TELEGRAM_BOT_USERNAME` to the bot's username without `@`.
6. Leave the signing algorithm at **RS256**. The implementation uses the
   `openid profile` scopes and does not request a phone number.
7. For production, repeat with the production bot and production origin.

Use the new OIDC Login Widget settings. The legacy `/setdomain` configuration
alone does not configure this flow. No additional Telegram JavaScript library
needs installing in the site. See [Telegram's login guide](https://core.telegram.org/bots/telegram-login).

**Check later:** L4–L6. Telegram login works without an email; connecting Telegram
is optional for an email account. Connecting and allowing bot messages are
separate actions. Email remains usable if Telegram is unavailable.

### 2.4 Retired provider credentials

Remove `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` from this application's environments if present. Revoke
only the corresponding unused OAuth applications if no other application uses
them. Public HQ uses email and Telegram; existing operator password login stays.

### 2.5 Environment variable inventory

All values below are server-side. None use a `NEXT_PUBLIC_` prefix.

| Variable | Value/source | Needed for |
|---|---|---|
| `DATABASE_URL` | Pooled URL for that environment's database | Runtime database access |
| `DATABASE_URL_UNPOOLED` | Direct URL with migration permissions | Migration command only |
| `HQ_SESSION_SECRET` | Existing production value; separate random staging value | Operator sessions |
| `BETTER_AUTH_URL` | That environment's HTTPS origin | Public auth and callback URLs |
| `BETTER_AUTH_SECRET` | Independent random secret, at least 32 characters | Public sessions |
| `RESEND_API_KEY` | Domain-restricted sending key | Email OTP and recovery email |
| `EMAIL_FROM` | Verified sender, with display name | Email delivery |
| `TELEGRAM_LOGIN_CLIENT_ID` | BotFather Login Widget | Telegram sign-in/linking |
| `TELEGRAM_LOGIN_CLIENT_SECRET` | BotFather Login Widget | Telegram sign-in/linking |
| `TELEGRAM_BOT_USERNAME` | Bot username without `@` | Bot links and copy |
| `TELEGRAM_BOT_TOKEN` | BotFather bot token | Bot transport |
| `TELEGRAM_WEBHOOK_SECRET` | Independent random secret | Webhook authentication |

No reminder-job shared secret, Colosseum API key, or Google/GitHub login key is
required. Keep migration credentials separate from runtime access. Configure
staging values only for the staging deployment/branch, not all unrelated previews.

For local use, copy `docs/hq/environment.example` into a gitignored environment
file and fill values privately. Any older `setup/hq/auth.env.template` is obsolete.
`next dev` and the HQ scripts prefer `.env.development.local` over `.env.local`; an
already exported environment variable wins over either. Verify the target database
before using a migration command. Never commit a populated environment file.

### 2.6 Colosseum edition mapping

**Where later:** Admin → Builder onboarding, for the selected HQ hackathon.

The implementation log records the verified World's Fair external mapping:

- External Colosseum edition ID: **7**.
- External slug: **crypto-worlds-fair**.
- HQ campaign dates: **14 September–12 October 2026**.
- Timezone: **Europe/Amsterdam**.

Enter the external ID and slug in Admin. The internal HQ hackathon ID is a
separate database key; do not replace it with 7 or assume that internal ID 6 is
Colosseum edition 6. An unconfigured mapping refuses imports with an explanation.

After saving the mapping and reporting schedule in the isolated deployment,
turn on **Enable project imports**. Clear **Project access date (UTC)** for
immediate test access, or set it to the intended opening instant. Imports are
disabled by default and remain unavailable before a future access date. Apply
the production opening settings only as part of the later approved rollout.

Imports require the source project to say `country: Netherlands` and match the
configured external edition ID. A successful import is immediately usable.
Paste the public project page link, for example
`https://colosseum.com/arena/projects/nihilium-recovery`. Older
`/arena/projects/explore/<slug>` links also work. HQ validates the link and
extracts its slug before calling the API; share parameters and fragments are
ignored.

Colosseum's project directory lists submitted projects of enabled editions;
it is not a feed of Dutch registrations. Individual public project links may be
importable while the directory is closed. Directory availability must be checked
again when testing; the earlier observation of a closed directory is not a live
status promise. There is no phase 9 discovery screen to configure.

Public project updates are synchronized separately from the project snapshot.
After migration, existing imports are picked up automatically by the HQ jobs
runner, regardless of their import date or reporting enrollment. Each pass
fetches a bounded batch, commits the upstream cursor with each page, and starts
a fresh sweep 30 minutes after reaching the end. Failed requests preserve saved
history and retry after 15 minutes. Opening history in the admin project,
team workspace or Captain's Den also performs a due sync and continues older
pages automatically. Archived editions are not fetched.

History retains original publication dates, written content and public links
(including videos), with one row per Colosseum post id. Repeated syncs update
source edits without duplicates. These records do not author HQ weekly reports
or change reporting outcomes. The authenticated Colosseum weekly-submission
endpoint is separate from public project updates and is not imported. The
jobs workflow must target the deployment being kept up to date when no one is
viewing its pages. The repository's scheduled workflow targets production.

### 2.7 Project fallback image

Already supplied. The local decorative globe is served through Next's size-aware
image optimizer. Imported third-party images load directly in the browser with
no HQ referrer; no unrestricted image proxy is introduced. No owner action.

### 2.8 Database and deployment, after you request the test environment

1. Create an isolated Neon branch/database and a private test deployment with
   the staging credentials above. Use synthetic accounts and test data.
2. Confirm the direct migration connection targets that isolated database.
3. From the repository root run `npm ci`, then `npm run hq:migrate` with that
   environment's `DATABASE_URL_UNPOOLED`. The migration applies the base schema,
   upgrades, member auth schema and builder schema in order. It is rerunnable;
   do not substitute `hq:reset` or `hq:seed` against an existing database.
4. This includes all phase tables and the review's `source_attempted_at` column,
   used to prevent failed Colosseum sources monopolizing refresh batches.
5. Deploy the reviewed branch with runtime variables. Do not expose production
   public signup as a side effect of configuring staging credentials.
6. Confirm the test operator can sign in. Before production rollout, verify a
   private backup/restore path, use the production migration credential, and
   check the existing operators and data after applying the migration.

Automated migration checks exercise fresh, older populated and repeated runs in
embedded PostgreSQL. Real PostgreSQL concurrent locks and recovery testing remain
part of the isolated environment session.

### 2.9 Telegram bot webhook, after the test deployment exists

1. Keep BotFather group privacy enabled. HQ reporting operates in private chats.
2. Generate the webhook secret with `openssl rand -hex 32` and store it as
   `TELEGRAM_WEBHOOK_SECRET`. Its allowed alphabet is letters, digits, `_`, `-`;
   HQ requires 16–256 characters.
3. Set the matching bot's `TELEGRAM_BOT_TOKEN` and redeploy with both variables.
4. Register `https://<test-origin>/api/telegram/webhook` with Telegram's
   `setWebhook`. Include `secret_token` and
   `allowed_updates: ["message", "callback_query"]`. Preserve pending updates
   when re-registering. The command below reads secrets from a private file,
   keeping literal credentials out of command history and printed output:

```sh
node --env-file=.env.hq-staging.local --input-type=module <<'NODE'
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, BETTER_AUTH_URL: origin } = process.env;
if (!token || !secret || !origin || !origin.startsWith('https://')) throw new Error('Missing staging bot settings');
try {
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: new URL('/api/telegram/webhook', origin).href,
      secret_token: secret, allowed_updates: ['message', 'callback_query'] }),
  });
  const result = await response.json();
  const registered = response.ok && result.ok === true;
  console.log({ registered });
  if (!registered) process.exitCode = 1;
} catch { console.error('Webhook registration failed; check the private settings and connection.'); process.exitCode = 1; }
NODE
```

5. Check `getWebhookInfo` privately: expected webhook URL, no current delivery
   error and a queue that drains. A 401 usually means mismatched webhook secrets;
   a 503 can indicate missing configuration or a temporary retryable failure.
6. Sign in to the test HQ account, connect its Telegram account and allow bot
   messages. Then open the test bot with that same Telegram account and send
   `/start`. If you sent it before linking, send it again after linking.
7. In Admin, grant the test account Captain access, or create a Captain invitation
   and redeem it with that account. Then assign a test project to the Captain.
   Access alone does not create an assignment or a project reminder target.
   New invitation links use a six-character code. Signed-out invitees choose
   **Log in or sign up**, finish their name if needed, and return to the
   invitation. Accepting opens the Home menu without initializing a team.
8. Run L15–L22 below. Do not point the production bot at the test environment.

Telegram's [webhook API](https://core.telegram.org/bots/api#setwebhook) documents
these fields. Login permission does not establish a private bot chat by itself;
`/start` binds the destination to the connected Telegram identity.

### 2.10 Reporting schedule

**Where later:** Admin → Weekly reporting, for the selected edition.

1. Check the campaign dates and Europe/Amsterdam timezone.
2. Set **Final submission period starts** to **5 October 2026**.
3. Set **Reminder day** to Wednesday and **Reminder time** to 12:00.
4. Save reporting settings. Review the date-change preview, then apply the
   hackathon dates to the weeks. Existing periods with reports or outcomes
   cannot silently move; resolve any displayed conflict first.
5. Confirm precisely these four periods:

| Week | Inclusive dates | Mode | Reminder |
|---|---|---|---|
| 1 | 14–20 September | Weekly | 16 September, 12:00 |
| 2 | 21–27 September | Weekly | 23 September, 12:00 |
| 3 | 28 September–4 October | Weekly | 30 September, 12:00 |
| 4 | 5–12 October | Final submission | 7 October, 12:00 |

There is no extra obligation beginning 12 October. Imported teams enter reporting
automatically; use **Add to weekly reporting** for manually created projects.
Late imports do not inherit missed weeks before they joined. Pauses preserve
history. Late updates are explicitly labelled and do not erase a missed week.
Voiding an entry in an open period recalculates its status. For a closed period,
the recorded outcome stays until an admin explicitly corrects it with a reason.

### 2.11 Scheduled jobs, after validation and production release approval

The existing workflow `.github/workflows/hq-jobs.yml` calls
`https://nl.superteam.fun/api/cron/hq-jobs` at :07 and :37 each hour. The due
reminder time remains 12:00 Amsterdam; actual delivery happens on the next
successful run and GitHub scheduling can be delayed.

1. Confirm the production URL in that workflow.
2. After staging passes and release is approved, migrate, merge and deploy the
   reviewed branch. No merge or deployment was performed by this review.
3. Ensure GitHub Actions is enabled. Run **HQ reporting jobs** manually from
   `main` and inspect its counts-only response.
4. Check Admin → Weekly reporting → Wednesday Captain reminders. Its **Run now**
   action uses the same runner and is the staging test entry point too. It
   processes due work across **all editions in that deployment**; the selected
   edition filters the displayed results, not the runner's scope.
5. Check the first due reminder and period closure. Repeated runs must not create
   duplicate logical reminders. A timeout is shown as uncertain, not as confirmed
   delivery. Blocked bots and exhausted attempts keep their recorded reason.

The endpoint verifies GitHub's short-lived OIDC token and pins the repository,
immutable IDs, workflow path, audience and `main` ref. A branch/fork cannot call
production through that policy. No Vercel Cron or permanent job secret is needed.
Deployment Protection must allow the Telegram webhook and scheduled endpoint to
reach the application; their own authentication still applies. Do not weaken
production authentication to make staging work.

Disable the GitHub workflow to stop scheduled work. Turning off a person's bot
messages stops delivery to that person. There is no per-person resend button or
global delivery feature flag; manual Run now also performs due sends.

### 2.12 Final submission settings

**Where later:** the same Weekly reporting panel.

1. Record the **actual Colosseum deadline**, whenever known, in the campaign
   timezone. **Read the deadline from Colosseum** can fill it when its directory
   is enabled. A failed read preserves the previous value. Confirm any fetched
   deadline against the official edition rules.
2. Mark each visible material Required, Optional or leave it Not known:
   presentation/pitch deck, pitch video, technical demo, demo video, repository,
   website. Record the official requirements; the public API does not provide
   a trustworthy per-field requirements list.
3. Leave automatic refresh empty to disable it, or select an interval of at least
   15 minutes. For this small batch, 60 minutes is a reasonable initial setting;
   confirm freshness under the expected number of teams during testing. The
   scheduler processes bounded batches, not every team simultaneously.
4. Check the team and Captain views during the final period. A complete checklist
   never implies submission. The **Check submission** button remains available.
5. After closure, inspect reconciliation in Admin. Unreachable or unknown evidence
   stays pending. An actual on-time submission discovered later may correct a
   missed outcome with an audit event; a late submission does not.

Until an official deadline is recorded, HQ falls back to its own final period
boundary, 13 October 00:00 Amsterdam. That fallback is not a claim about
Colosseum's cutoff. Reconciliation preserves the deadline captured when its
pending record opens after closure; a later settings edit does not silently
rewrite it.

## 3. Live verification checklist for the next session

These checks require the isolated environment. For the 18 September redesign,
start with [the redesign testing handoff](redesign-readiness.md); its migration
and deployment are complete on staging. Existing L numbers are retained
so earlier implementation-log references still resolve.

| Checks | Test and expected result |
|---|---|
| L1–L3 | New email account, real OTP delivery, wrong/expired/replayed code, resend limits and provider failure. No false delivery success. |
| L4–L6 | Telegram-only signup, email-account linking, duplicate identity conflict, cancelled login, unlink-last-method refusal and interrupted unlink cleanup. |
| L7–L9 | Secure/HttpOnly cookies; logout/session expiry; protected routes and actions reject unauthorized requests. |
| L10 | Existing operator username/password login, forced password change and logout still work. |
| L11 | Current-edition Dutch import succeeds; wrong country/edition, invalid/unavailable source and duplicate import each show their own message. |
| L12 | Captain invitations: one/many uses, expiry, revocation, repeat redemption and simultaneous different invitations for the same account. |
| L13 | Compare draft and submitted Colosseum evidence; unknown/error preserves honest state. |
| L14 | Invitation/join routes send no-referrer and noindex headers; link previews do not redeem a role. |
| L15–L17 | Bot `/start`, chat binding, consent on/off, linked identity conflicts, non-Captain denial and private-chat-only behavior. |
| L18–L20 | Bot draft/preview/save/cancel, sensitive note, edit conflict, retry after failed preview, long text and non-default edition navigation. |
| L21–L22 | Join links, claimed/expired/reissued seats, lead controls, reassignment and deletion impacts; sensitive notes remain author/admin only. |
| L23–L27 | Synthetic due reminders, duplicate/overlapping runs, timeout/blocked bot, retry timing, catch-up closure, pauses and DST. No real public reminders. |
| L28–L29 | Admin deadline/material settings, bounded refresh during an outage, unknown reconciliation, late evidence and unchanged historical cutoff. The old member submission panel and operator correction UI were removed by the redesign; correction semantics remain service-level checks. |

Also test the full member → Captain → admin flow in mobile Safari and Chrome,
plus desktop Chrome/Firefox/Safari. Include 375, 768 and 1280 px layouts,
keyboard navigation, reduced motion, slow network, validation errors, newly saved
updates, older-page edits, explicit late updates, and operator project/People
edits. Captain notes must never complete the team's week. Weekly-report
moderation and pause/correction controls are no longer exposed in the UI.
Measure authenticated page latency, SQL query counts and network payload sizes
using representative synthetic data. Bundle compilation alone does not prove
smooth behavior on devices.

## 4. Operations and rollback

- Keep database restore access private and confirm the restore window before
  production migration. Roll back application code without dropping new tables.
  Preserve notes and revisions; never use reset/seed as a rollback.
- Watch webhook errors, job results, missed-period history and pending submission
  checks in HQ. Logs must not contain credentials, draft bodies or invitation tokens.
- To rotate a bot token, obtain the replacement from BotFather (the old token is
  invalidated), update that environment, redeploy and re-register its webhook.
  Rotating the webhook secret requires updating both deployment and registration.
- Public auth secret rotation invalidates public sessions. Preserve the separate
  operator secret unless deliberately rotating operator sessions too.
- Cleanup runs with scheduled jobs: draft lifetime 30 minutes, ordinary bot
  buttons 24 hours, finished webhook receipts 7 days, finished outgoing messages
  90 days and resolved closed-week reminder records 180 days. Reporting entries,
  revisions, outcomes and audit history have no automatic expiry. Decide their
  longer-term retention before public rollout; deletion/moderation have different
  documented effects and should not be used as an accidental retention policy.
- Provider outages do not require rolling back web reporting. Disable the affected
  integration/workflow, preserve its state, fix the underlying configuration and
  rerun the relevant isolated checks before re-enabling it.
