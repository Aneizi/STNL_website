# Public HQ account setup

Public builders sign in at `/hq/signup` or `/hq/signin`. They use Google, GitHub, or a six-digit email code. Their sessions and auth tables are independent from the operator login at `/hq/login`.

The public account's Regular/Member tier belongs to the application profile, not to the authentication provider. Only an operator can assign Member status. Public authentication never grants access to the admin CRM.

## Environment variables

Set these in the existing Vercel project and in a git-ignored local environment file. Never expose them using `NEXT_PUBLIC_` variables.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Existing pooled Postgres connection |
| `BETTER_AUTH_URL` | Exact application origin, `https://nl.superteam.fun` in production |
| `BETTER_AUTH_SECRET` | Independent random secret, at least 32 characters |
| `GOOGLE_CLIENT_ID` | Google OAuth web application client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GITHUB_CLIENT_ID` | GitHub OAuth application client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret |
| `RESEND_API_KEY` | Resend sending key |
| `EMAIL_FROM` | Sender on a verified domain, such as `Superteam NL <hq@your-verified-domain>` |

Generate the auth secret with a password manager or `openssl rand -base64 32`, and enter it directly into Vercel's encrypted environment settings. Keep it distinct from `HQ_SESSION_SECRET`. A secret rotation invalidates public sessions and can affect encrypted OAuth tokens.

When credentials are absent, the affected sign-in method is visibly unavailable. There is no fake email delivery, local bypass, or automatic admin login.

## Google

Create an OAuth web application in Google Cloud. Configure the consent screen for the production audience and add these authorized redirects:

- `https://nl.superteam.fun/api/auth/callback/google`
- `http://localhost:3000/api/auth/callback/google` for local development

Use only the default identity/email scopes. Register each real application origin explicitly. [Google provider setup](https://better-auth.com/docs/authentication/google)

## GitHub

Create an OAuth application with homepage `https://nl.superteam.fun` and callback `https://nl.superteam.fun/api/auth/callback/github`. Use a separate development OAuth application for `http://localhost:3000/api/auth/callback/github`. GitHub sign-in needs the user's verified email, including private email addresses. An OAuth application requests the email scope; a GitHub App instead needs the Email addresses read permission. [GitHub provider setup](https://better-auth.com/docs/authentication/github)

## Email codes

Create a Resend sender, add its DNS verification records, and wait for domain verification. Store the sending key as `RESEND_API_KEY` and use an address on that verified domain in `EMAIL_FROM`. The hosted app does not need a separate email server. [Resend setup](https://resend.com/docs/send-with-nextjs)

Codes expire after five minutes, are stored as hashes, and allow three verification attempts. Requesting a new code replaces the previous one. A valid code creates or signs in the public account. Sending a code alone does not create a Person. The app awaits the sender response so a failed send is reported honestly. [Better Auth email OTP](https://better-auth.com/docs/plugins/email-otp)

## Database migration

Apply `scripts/hq/member-auth-schema.sql` to an isolated development database first, alongside the HQ application migrations. It only creates prefixed auth tables and indexes:

- `hq_auth_user`
- `hq_auth_session`
- `hq_auth_account`
- `hq_auth_verification`
- `hq_auth_rate_limit`

The SQL matches Better Auth 1.7.2, including the required OAuth `issuer` column. No operator passwords or sessions are migrated. Apply the same additive migration to production before enabling public signup.

Verified account creation synchronizes the user into the public profile and People CRM. Loading a protected public page repeats the idempotent synchronization, so an interrupted CRM write can recover on the next visit.

If a new user enters through the email sign-in screen without a name, their verified session first opens `/hq/profile`. They provide their name once before the Person is created and enrollment proceeds. Returning users with complete profiles never see this extra step. A safe public destination, including a pending team invitation, is preserved through authentication and profile completion.

## Vercel deployment and verification

Redeploy after setting credentials. `BETTER_AUTH_URL` must match the origin used to open the app. For preview deployments, use a stable, separately registered preview origin with its own development database and credentials. Do not send preview users through production callbacks or allow arbitrary origins.

The API uses the Node.js runtime and the existing Postgres driver. Rate limits are stored in Postgres so separate Vercel instances share them. Public sessions use the `stnl_builder` cookie prefix with HTTP-only cookies and secure cookies in production. [Next.js integration](https://better-auth.com/docs/integrations/next), [rate limiting](https://better-auth.com/docs/concepts/rate-limit)

Before opening signups, verify each real provider with an authorized test account: sign in, reach the public welcome page, see the person in the selected CRM, sign out, and confirm that the public session cannot access operator pages. Confirm an incorrect, expired, and reused email code is rejected. Repository tests exercise these local auth boundaries and stub email delivery; they do not verify the external provider credentials or inbox delivery.
