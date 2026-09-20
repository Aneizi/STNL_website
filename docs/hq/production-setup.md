# Production setup — Superteam NL

Release date: 20 September 2026. This is the production handoff; the older
[manual setup](manual-setup.md) and [staging guide](staging-environment.md)
contain historical test-environment instructions.

## Live environment

| Item | Production value |
| --- | --- |
| Website and auth origin | `https://nl.superteam.fun` |
| Vercel team / project | `stnl` / `stnl-website` |
| Git repository / production branch | `Superteam-Netherlands/website` / `main` |
| Database resource in Vercel Storage | `stnl-hq-db` |
| Database project | `flat-violet-73201541` |
| Database endpoint | `ep-tiny-tooth-b1s882ns.c-5.eu-central-1.aws.neon.tech` |
| Runtime / function region | Node.js 24.x / Frankfurt (`fra1`) |
| Member login | `https://nl.superteam.fun/hq/login` |
| Admin login | `https://nl.superteam.fun/hq/admin/login` |

The separate `stnl-hq-staging` project, `stnl-hq-staging-db` database and
`@stnl_test_bot` remain staging resources. Do not copy their credentials or
data into production. Vercel also calls the staging project's stable deployment
“Production”; always check the **project name**.

## Completed during release

- Applied the checksummed `0001-legacy-bootstrap` migration to the existing
  production database after a transactional rehearsal that was rolled back.
- Compared protected records inside the database before committing. All three
  admins, their passwords and sessions, and existing operational records were
  preserved. No reset, reseed, or staging-data import was used.
- Removed two confirmed test People records and four activity messages about
  test records. Production retains seven real People records, 37 partners,
  58 events, and all three admins. It had zero public member accounts and zero
  projects at release. No staging accounts or projects were imported.
- Restricted both database environment variables and the Vercel Storage
  connection to **Production only**. Pooled and direct URLs still identify the
  original database. Preview and Development require their own database.
- Preserved `HQ_SESSION_SECRET`; set the production auth origin, independent
  `BETTER_AUTH_SECRET` and `TELEGRAM_WEBHOOK_SECRET`, and the intended sender.
- Confirmed the custom domain, `main` production branch, Node.js version,
  Frankfurt region, and production endpoints in both GitHub workflows.
- Restricted scheduled workflows to the canonical repository so mirrors do
  not call production. No bot messages or verification emails were sent.

The application passed 1,934 tests, lint, TypeScript, its production build, and
the production dependency audit (zero reported vulnerabilities).

## 1. Add the remaining Vercel credentials

Open [stnl-website settings](https://vercel.com/stnl/stnl-website/settings/environment-variables).
Select **Production** for every value below. All are server variables; do not
add a `NEXT_PUBLIC_` prefix.

| Variable | Status / action |
| --- | --- |
| `DATABASE_URL` | Already set: original production pooled URL. Keep it. |
| `DATABASE_URL_UNPOOLED` | Already set: original production direct migration URL. Keep it. |
| `HQ_SESSION_SECRET` | Existing production secret preserved. Keep it. |
| `BETTER_AUTH_URL` | Already set to `https://nl.superteam.fun`. |
| `BETTER_AUTH_SECRET` | New independent production secret already set. |
| `EMAIL_FROM` | Already set to `Superteam NL <noreply@nl.superteam.fun>`. |
| `RESEND_API_KEY` | **Add** a production sending key for the verified domain. |
| `TELEGRAM_LOGIN_CLIENT_ID` | **Add** the production bot's OIDC Client ID. |
| `TELEGRAM_LOGIN_CLIENT_SECRET` | **Add** the production bot's OIDC Client Secret. |
| `TELEGRAM_BOT_USERNAME` | **Add** the production bot username, without `@`. |
| `TELEGRAM_BOT_TOKEN` | **Add** the production bot's BotFather token. |
| `TELEGRAM_WEBHOOK_SECRET` | Independent production secret already set; use the same value when registering the webhook. |

Mark provider credentials as **Sensitive**. After adding them, **redeploy the
latest `main` deployment**. Existing deployments retain their original
environment variables. The same applies to old previews: changing scopes does
not remove credentials already embedded in those deployments. Keep preview
deployment protection enabled and retire old previews before giving others access.
[Vercel environment updates](https://vercel.com/docs/environment-variables/managing-environment-variables).

Until a production Resend key or Telegram OIDC credentials are supplied, member
sign-in remains unavailable. Admin username/password login remains independent.
The bot remains disabled until its token is supplied and its webhook registered.

The newly generated production secrets are also saved privately on the release
machine in `setup/hq/production/generated.env` (gitignored, owner-readable).
Move them into your password manager. Vercel does not reveal Sensitive values
through `env pull`; `[SENSITIVE]` is a placeholder, never a usable secret.

## 2. Configure Resend and DNS

1. In Resend, verify the sending domain **`nl.superteam.fun`**. Confirm its current
   SPF/DKIM status; the staging sender uses the same domain.
2. If records are missing, give the DNS administrator Resend's exact generated
   records, including record type, name, value and any MX priority.
3. Create a production sending key restricted to that domain and add it as
   `RESEND_API_KEY` in Vercel Production. Keep staging's key separate.
4. Redeploy, then sign in with your own real email and confirm that the code
   arrives. Use a real account you intend to keep; no dummy account is needed.
5. Monitor Resend delivery failures and account limits. No incoming mailbox is
   required for `noreply@nl.superteam.fun`.

Use the exact DNS values in [Resend's domain dashboard](https://resend.com/domains);
the [domain guide](https://resend.com/docs/dashboard/domains/introduction)
explains verification. Do not use `onboarding@resend.dev` for public login.

## 3. Configure the production Telegram bot

In [BotFather](https://t.me/BotFather), use a production bot distinct from
`@stnl_test_bot`. Keep group privacy enabled; HQ uses private chats.

Open the bot's **Login Widget / OpenID Connect Login** settings. Switch to
OpenID Connect if the interface initially shows only the legacy widget.

| BotFather field | Exact production value |
| --- | --- |
| Trusted Origins | `https://nl.superteam.fun` |
| Redirect URIs | `https://nl.superteam.fun/api/auth/callback/telegram` |
| Signing algorithm | `RS256` |
| Native Login | Leave empty |

Use no trailing slash. Copy the OIDC Client ID and Client Secret into the two
`TELEGRAM_LOGIN_*` variables. They are different from the bot token. Configure
the username and bot token too, then redeploy.
[Telegram OIDC documentation](https://core.telegram.org/bots/telegram-login).

Register the webhook **after** the deployment contains the bot token and webhook
secret. Its production URL is:

`https://nl.superteam.fun/api/telegram/webhook`

Create a private, gitignored `.env.hq-production.bot.local` containing
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, and the **already configured**
`TELEGRAM_WEBHOOK_SECRET`. The following command verifies the bot identity,
registers only the update types HQ consumes, and preserves pending updates:

```sh
node --env-file=.env.hq-production.bot.local --input-type=module <<'NODE'
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_BOT_USERNAME: username,
  TELEGRAM_WEBHOOK_SECRET: secret } = process.env;
if (!token || !username || username.replace(/^@/, '') === 'stnl_test_bot'
  || !/^[A-Za-z0-9_-]{16,256}$/.test(secret ?? '')) {
  throw new Error('Missing or incorrect production bot settings');
}
async function call(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error('Telegram API request failed');
  return payload.result;
}
try {
  const bot = await call('getMe', {});
  if (bot.username !== username.replace(/^@/, '')) throw new Error('Wrong bot');
  const url = 'https://nl.superteam.fun/api/telegram/webhook';
  await call('setWebhook', { url, secret_token: secret,
    allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
  const info = await call('getWebhookInfo', {});
  console.log({ registered: info.url === url, pendingUpdates: info.pending_update_count,
    hasDeliveryError: Boolean(info.last_error_message) });
} catch {
  console.error('Webhook setup failed. Check the private settings and connectivity.');
  process.exitCode = 1;
}
NODE
```

Telegram documents [webhook registration and status](https://core.telegram.org/bots/api#setwebhook).
No Vercel bypass token should be needed on the public custom domain. A webhook
401 indicates incorrect webhook authentication; a 503 can indicate missing bot
configuration or a retryable failure. The webhook accepts POST requests.

For each Captain: sign in or connect Telegram in Account, enable reminders,
then open the production bot and send `/start` using that same Telegram account.
If they started the bot before linking, send `/start` again. Grant Captain access
or redeem a Captain invitation, then assign the Captain's actual projects.
Telegram login, reminder consent, starting the bot, and project assignment are
separate requirements.

## 4. Finish the real campaign configuration in HQ

Open [Admin](https://nl.superteam.fun/hq/admin) using an existing admin account,
and select **Colosseum World's Fair** (internal HQ ID **6**).

- **Builder onboarding:** the external mapping is currently blank and imports
  are closed. The previously verified external Colosseum mapping is ID **7**,
  slug **`crypto-worlds-fair`**. Confirm this edition, enter the mapping, and
  enable project imports when member login is working. Clear Project access date
  for immediate opening, or enter your actual opening instant in UTC.
- **Campaign dates:** existing dates are **14 September–12 October 2026**,
  timezone **Europe/Amsterdam**. The production reporting launch date already
  saved in the database is **21 September 2026**; preserve it so teams do not
  inherit reporting obligations from before launch.
- **Weekly reporting:** set Final submission period starts to **5 October 2026**,
  Reminder day to **Wednesday**, and Reminder time to **12:00**. Save, preview,
  and apply the schedule. At handoff no reporting configuration or periods had
  been saved in production.
- Review the resulting periods beginning **21 September**, **28 September**,
  and **5 October**. The final period runs through **12 October** inclusive.
- Record the actual official Colosseum deadline and required/optional materials
  from the edition rules. The HQ end date is not evidence of Colosseum's cutoff.
  Use Read the deadline from Colosseum when available, then verify the result.
- Set the automatic submission-refresh interval if wanted (minimum 15 minutes),
  and assign real teams to Captains. Importing actual projects is sufficient;
  do not seed demonstration teams or reporting notes.

Colosseum public project imports and post history need no API key. Public post
sync is independent of HQ weekly reports and does not mark a week complete.

## 5. GitHub jobs and Luma

In [the canonical repository's Actions](https://github.com/Superteam-Netherlands/website/actions),
ensure Actions is enabled and both workflows are active:

| Workflow | Schedule | Production endpoint |
| --- | --- | --- |
| HQ reporting jobs | Every hour at :07 and :37 | `/api/cron/hq-jobs` |
| Sync Luma events | Daily at 00:17 UTC | `/api/cron/sync-luma` |

Both use GitHub's short-lived OIDC tokens, pinned to this repository and `main`.
No GitHub job secret, `CRON_SECRET`, or Vercel Cron setup is required. They are
skipped in the mirror repository. GitHub can delay scheduled runs.

After configuring the campaign and bot, run each workflow manually from **main**
and inspect its counts-only result. The HQ job processes due work across all
editions, including actual reminder sends. Do not run it as a dummy-data test.
Check the first Wednesday reminder and reporting closure in HQ Admin.

The Luma mirror reads the public **`luma.com/stnl`** calendar. No Luma API key or
webhook is required. Keep actual event information current in that calendar.

## 6. Final owner checks and recovery

1. Log in at `/hq/admin/login` with your unchanged admin credentials and inspect
   People, Partners, Events, and Admin.
2. Complete a real email login, a real Telegram login, and a production bot
   `/start`. These provider checks need your credentials/account interaction.
3. Import a real Dutch project for the configured edition and check the member,
   Captain, and admin views. Use staging for synthetic failure tests.
4. Check Vercel runtime logs, Resend deliveries, Telegram webhook status and the
   two GitHub Actions results. Confirm there are no configuration errors.
5. Confirm database recovery ownership and retention through the Vercel Storage
   integration. No new provider snapshot was created by this release: the
   available Vercel CLI exposed resource management, but no restore-point command.
   The migration rehearsal verified rollback, which is not a durable backup.
6. For application rollback, use Vercel's previous production deployment. Preserve
   the migrated schema and live data; never use `hq:reset`, reseeding, or staging
   data restoration as rollback. Future migrations must be new numbered files.

The full local database export was blocked by automatic approval because it
would have included credential-bearing rows. Release verification instead kept
temporary comparison copies inside PostgreSQL and returned only preservation
results; these copies were dropped automatically when the transaction ended.
Private release reports are in the gitignored `setup/hq/production/` directory.
