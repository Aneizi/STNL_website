# HQ staging access and next tests

Created 16 September 2026 with the owner's approval. This is the isolated
environment for the reviewed `hq-captains-phases-0-2` working tree, including
uncommitted review fixes. Phase 9 remains excluded.

**18 September redesign deployed:** the reviewed `colosseum-hq` checkout,
including the completion-review fixes, is live at the stable staging address in
deployment `dpl_13UPmmKXSeBjBMdyRydN4sYEMwsm`. The additive schema migration
passed with existing records preserved. Hosted build and all 14 HTTPS smoke
checks passed. Follow [the redesign testing handoff](redesign-readiness.md)
for the interactive test pass; Colosseum posts/videos sync remains deferred.

**18 September public testing access:** Vercel Authentication was disabled on
the separate staging project at the owner's request. The stable link opens
without a Vercel account. All 14 HTTPS checks passed without bypass headers or
Vercel cookies; application member/admin sign-in and webhook authentication
remain enforced.

**18 September team setup navigation:** sign-up/sign-in still opens **Find your
team**. Successful team import or teammate joining now opens the **Home menu**,
where the hackathon tile leads to the team. This is live in deployment
`dpl_StanJLyfUMxwZy7AhWZcoiubExBC`; the hosted build and 15 public HTTPS checks
passed, alongside 73 focused local tests, TypeScript and scoped lint.

**18 September Captain invitation update:** new links use six-character codes.
Signed-out invitees see **Log in or sign up**, return to the invitation after
authentication/name setup, then accept to open the Home menu without team
initialization. Existing links remain valid. Deployment
`dpl_EzUNzxZPiLEdfT4KN1H9xGV5RJkt` passed its hosted build, 16 public HTTPS
checks, 355 focused local tests, TypeScript and scoped lint.

**18 September Captain welcome popup:** newly accepted Captains now see
“You're now a captain. Go to the Captain's Den” over the menu. The Den text
links to the Captain page; Okay, Escape or clicking outside dismisses it, and
it fades out automatically after 10 seconds. Deployment
`dpl_5XqN77xRTKJSerpT1zqChZfMoo4i` passed its hosted build and 17 public HTTPS
checks. Local checks covered 68 tests, TypeScript, lint and desktop/mobile
popup behavior.

**18 September Captain team assignment guidance:** the empty Den now says
“No teams assigned yet. Reach out to an admin to link your teams to you.”
Deployment `dpl_4rgSfWoF1W4s59zJYgULUrankRxT` passed its hosted build and all
17 public HTTPS checks; 57 related local tests and scoped lint also passed.

**18 September HQ navigation:** Back on Find your team returns to the HQ menu.
The login screen's link to the public start page was removed. The HQ navigation
audit found no other navigation controls leading to public website pages.
Deployment `dpl_BCek6xerPHwEHHjkh8Jb5FGAyP2E` passed its hosted build and all
18 public HTTPS checks, with 52 related tests, TypeScript and scoped lint passing.

**19 September Captain button feedback:** Make Captain shows a spinning loader
and “Making Captain…” while pending, with duplicate submissions disabled.
Remove Captain uses the same feedback. Failed requests restore the control and
show an error. Deployment `dpl_8oktCfiR2vP5JZC2zDmQhe9Q9ALr` passed its hosted
build and all 18 public HTTPS checks. Local tests, TypeScript, lint and browser
checks of pending, failure, retry and success behavior passed.

**19 September daily email quota guidance:** Resend's daily-limit response now
shows “We've reached our daily email limit. Continue with Telegram or try again
tomorrow.” A failed resend also offers Telegram from the code-entry screen,
preserving the intended destination. Deployment
`dpl_7GNUNt5WDoJcw9gJS79NFuVwu4MP` passed its hosted build and all 18 public
HTTPS checks, alongside 142 related tests, TypeScript, lint and a local browser
preview with simulated quota responses. No verification emails were sent.

**19 September HQ entry login:** visiting `/hq` without an operator session
cookie redirects to the normal member login, `/hq/login`. Operator cookies
still reach the dashboard's full session check; deeper operator pages keep
their admin login. Deployment `dpl_BpBkiRjyGhemvv62ix62WJPJ4EW1` passed its
hosted build and all 19 public HTTPS checks, including the cookie-less entry.
All 272 related local tests, TypeScript and scoped lint passed.

## Environment

| Item | Value |
|---|---|
| Website | https://stnl-hq-staging.vercel.app |
| Vercel account / scope | `netherlands-2227` / `stnl` |
| Separate Vercel project | `stnl-hq-staging` |
| Fresh Neon resource | `stnl-hq-staging-db`, free plan, Frankfurt |
| Application runtime | Node.js 24.x, Next.js 16.3.5; functions configured for Frankfurt |
| Access protection | Public link; application member/admin sign-in remains required |
| Test bot | `@stnl_test_bot` |
| Email sender | `Superteam NL <noreply@nl.superteam.fun>` |
| Test edition | `900001` — `[TEST] Crypto Worlds Fair — HQ staging` |

The existing `stnl-website` project, `stnl-hq-db` resource and their credentials
were not changed. The repository's `.vercel/project.json` still identifies the
existing project. The staging deployment uses a separately linked temporary
source snapshot. Vercel calls its stable deployment “Production”; that label
belongs only to the separate **staging project**.

## 1. Finish the test bot's login configuration

In BotFather, select **stnl_test_bot → OpenID Connect Login** and save these
exact entries in their respective fields:

| Field | Value |
| --- | --- |
| **Redirect URIs** | `https://stnl-hq-staging.vercel.app/api/auth/callback/telegram` |
| **Trusted Origins** | `https://stnl-hq-staging.vercel.app` |

Do not add a trailing slash. Leave **Native Login** empty and keep the signing
algorithm at **RS256**. Client credentials are already configured. The owner's
live attempt reached the callback and verified Telegram's signed response, so
the redirect configuration is working. Live diagnosis found that Telegram sends
the profile user ID as a string. The parser now accepts both canonical decimal
strings and safe integer numbers. The correction is deployed and passes 63
Telegram tests; a completed live sign-in still needs verification.

The webhook is already registered and has independent Telegram authentication.
Its existing URL includes a private Vercel automation bypass from the original
protected setup; the bypass is now unnecessary but remains private. No webhook
registration change is needed for public testing access.

## 2. Sign in as the test operator

1. Open [operator login](https://stnl-hq-staging.vercel.app/hq/admin/login).
2. Use username **staging-admin** and the temporary password in the private,
   gitignored local file `setup/hq/staging/operator-credentials.json`.
3. Complete the required password replacement. Keep the new password privately;
   the local JSON file retains the old temporary password afterward.
4. Select **[TEST] Crypto Worlds Fair — HQ staging**.

This account is the operator account. Member email/Telegram sign-in is a separate
flow, matching the application's existing separation of roles.

## 3. Test member sign-in

1. Open [member sign-in](https://stnl-hq-staging.vercel.app/hq/login).
2. Test **Continue with email** with an inbox you control. Confirm the code
   arrives from the chosen sender and completes sign-in.
3. Test **Continue with Telegram** after saving the BotFather entries.
4. Check account linking separately: email and Telegram can be linked to one
   account; receiving bot messages requires an additional explicit opt-in.
5. After linking and opting in, open `@stnl_test_bot` and send `/start`.

No email or bot messages were sent during provisioning. Real OTP delivery,
Telegram authorization, identity linking and opted-in bot delivery still need
these interactive checks.

## 4. Continue the feature test pass

- Imports are enabled and explicitly mapped to Colosseum edition `7`,
  `crypto-worlds-fair`. Paste the direct project-page link. The project's
  country and edition checks still apply.
- Exercise teammate join links, Captain invitation/assignment from People and
  Projects, member updates and late updates, private Captain notes, account
  modals, high-potential flags and Admin reporting settings using this edition.
  The redesign removed the per-project reporting/submission panel and its
  operator correction controls.
- The synthetic HQ reporting window is **14 September–11 October 2026**,
  Amsterdam time, with four periods and a final period on 5–11 October. These
  are test fixture dates; they do not assert the official external deadline.
- Official submission deadline and required/optional materials remain Unknown.
  Confirm and configure those through Admin before testing submission timing.
- Automatic source refresh is off and no staging cron/job schedule was created.
  Exercise **Run now** manually after the relevant test accounts have opted in.
- Continue the complete live checklist in [the owner manual](manual-setup.md#3-live-verification-checklist-for-the-next-session)
  before considering public release. Mobile interaction, authenticated page
  performance and real PostgreSQL concurrency/recovery remain part of that pass.

## Completed verification

- The Colosseum HQ redesign and completion-review fixes are live in deployment
  `dpl_13UPmmKXSeBjBMdyRydN4sYEMwsm`; the stable alias was verified against
  that exact deployment. The hosted build and all 14 HTTPS checks passed,
  including enabled email/Telegram providers, member/operator boundaries,
  sign-in redirects, access protection and webhook authentication. Migration
  checks verified both new boolean columns and preserved counts for projects,
  roster, People, accounts, sessions, reporting entries/revisions, join links
  and outgoing messages. No reset/reseed, live OTP or bot delivery was run.
- Branded verification emails are live in deployment
  `dpl_D5Y7GZBS5ZY7oGqV2gc9evETDrbv`: the supplied logo, a large centered code,
  a simple bordered box, and the existing 15-minute expiry. All 99 focused auth
  tests and 14 HTTPS checks passed. The hosted build verified the inline logo
  is bundled with the auth function. Desktop/mobile previews were checked;
  a new sign-in request can verify delivery in a real inbox.
- Member login is `/hq/login`; operator login is `/hq/admin/login`, explicitly
  marked “For admins only.” `/hq/signin` permanently redirects to member login
  and preserves return destinations and repeated error parameters. Deployment
  `dpl_7UhbtQqoJdr8pd5cczUoG11wHUqu` passed the hosted build and all 14 HTTPS
  checks, including both authentication boundaries. Existing sessions remain.
- “Enter HQ” sign-in and 15-minute email codes are live in deployment
  `dpl_44ydtEfKUwyLf426qpTJ97BUMKkR`. The hosted build, 117 focused auth tests
  and all 13 HTTPS checks passed. No live verification emails were sent.
- Home's rectangular menu is live in deployment
  `dpl_DS6Je8VWyhDHaEz5uEM86ZJLjL6e`. Additional unjoined hackathons appear
  only while active; existing teams and hosting history remain reachable.
  Updates stay off Home, with actionable requirements represented by a red
  corner dot. The signed-in Home and hackathon menu were verified, and all
  13 HTTPS checks passed, including the new page's authentication guard.
- At the owner's request, staging was reset after the dashboard rollout.
  All 45 test-data tables, including public accounts/sessions, teams, imports,
  People, CRM identities and reporting history, were verified empty after one
  transaction. Operator access, edition settings and classifiers were preserved.
  The Telegram processed-update ledger remains to prevent delayed webhook replay.
  Start again at `/hq/login`; previous team links no longer resolve.
- The simplified team dashboard, import-help dialog and teammate-selection flow
  are live in deployment `dpl_38BU9Uuqj5nQwjua4SLjKnChdnkU` at the stable staging
  address. The migration preserved existing projects, roster references, People,
  CRM persons and legacy invites. Reusable links explicitly have no expiry;
  legacy link inserts retain their two-day default during deployment.
- The new hosted build and TypeScript compilation passed, followed by all 12
  HTTPS smoke checks. The owner's existing browser session loaded the new team
  dashboard and expandable details. The import-help popup correctly omitted
  Telegram username entry for the connected account. Existing imports keep their
  old roster records; an owner without a claimed identity can select themselves
  through the shared team link. No identity was selected on the owner's behalf.
- The fresh database migration and synthetic seed passed: **65 HQ tables**,
  one operator and one labelled edition. No production data was copied.
- The hosted build and TypeScript compilation passed on Node.js 24.x.
- **12 HTTP checks passed**: outer protection, enabled sign-in providers,
  anonymous session behavior, member/operator access guards and webhook rejection.
- **5 operator checks passed** through the deployed Next.js form: successful
  login, secure cookie flags, password-change form, enforcement of initial
  password replacement, and isolation from member sign-in.
- Live testing exposed a missing explicit auth cache header. All auth responses
  now use `private, no-store`, with cookie/redirect preservation verified by
  **66 passing related tests**, TypeScript and scoped lint. The correction was
  redeployed and confirmed over HTTPS.
- The bot identity and webhook registration were verified; pending updates were
  zero and no delivery error was reported at registration.
- All **14 secret-bearing staging variables**, including integration aliases,
  are stored as Secret. Private local files have permissions `0600`.
- Final database checks found zero public accounts, verification codes, member
  sessions, webhook receipts and outgoing messages. The only login exercise
  used the synthetic operator; its temporary password was left unchanged.

## Local handoff files

Private operational files live in ignored `setup/hq/staging/`: provisioning
state, source manifest, seed helper, smoke reports and temporary operator
credentials. Staging environment files are also gitignored. They were excluded
from the deployment upload and contain information that must remain private.

The source snapshot location is recorded in `setup/hq/staging/state.json`. It
is temporary; recreate it from the reviewed working tree before later redeploys
if the directory has been cleaned up. Always verify the snapshot's project link
is **stnl-hq-staging** before deploying. The reviewed HQ source is checkpointed
on the `staging` branch. The separate test site is publicly reachable; its
deployment uses the isolated project link described above.
