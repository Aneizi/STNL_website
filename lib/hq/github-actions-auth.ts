import "server-only";

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export const LUMA_SYNC_AUDIENCE = "stnl-luma-sync";

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS = createRemoteJWKSet(
  new URL(`${GITHUB_ISSUER}/.well-known/jwks`),
);

// Immutable IDs prevent a deleted/renamed GitHub namespace from inheriting
// permission to call the production sync endpoint.
const REPOSITORY = "Superteam-Netherlands/website";
const REPOSITORY_ID = "1313967087";
const REPOSITORY_OWNER_ID = "278071737";
const MAIN_REF = "refs/heads/main";
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/sync-luma.yml@${MAIN_REF}`;

/** Claim policy kept separate from signature verification so it is unit-testable. */
export function isTrustedLumaSyncClaims(payload: JWTPayload): boolean {
  return (
    payload.repository === REPOSITORY &&
    String(payload.repository_id) === REPOSITORY_ID &&
    String(payload.repository_owner_id) === REPOSITORY_OWNER_ID &&
    payload.ref === MAIN_REF &&
    payload.workflow_ref === WORKFLOW_REF &&
    payload.runner_environment === "github-hosted" &&
    (payload.event_name === "schedule" || payload.event_name === "workflow_dispatch")
  );
}

/** Verifies GitHub's short-lived OIDC identity; no shared secret is required. */
export async function isTrustedLumaSyncRequest(request: Request): Promise<boolean> {
  const header = request.headers.get("authorization");
  const match = /^Bearer ([^ ]+)$/.exec(header ?? "");
  if (!match) return false;

  try {
    const { payload } = await jwtVerify(match[1], GITHUB_JWKS, {
      algorithms: ["RS256"],
      audience: LUMA_SYNC_AUDIENCE,
      issuer: GITHUB_ISSUER,
    });
    return isTrustedLumaSyncClaims(payload);
  } catch {
    return false;
  }
}
