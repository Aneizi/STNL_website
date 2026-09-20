/**
 * A verified identity mirror remains usable only while its Better Auth
 * provider account exists. Unlink cleanup uses a second pool after commit,
 * so a failed cleanup must not leave Telegram access or deliveries enabled.
 * The alias is a fixed identifier supplied by the calling SQL, never input.
 */
export function activeTelegramIdentitySql(alias = "i"): string {
  return `EXISTS (SELECT 1 FROM hq_auth_account identity_account
    WHERE identity_account."userId" = ${alias}.user_id
      AND identity_account."providerId" = 'telegram'
      AND identity_account."accountId" = ${alias}.provider_subject)`;
}
