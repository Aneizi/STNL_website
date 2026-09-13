import "server-only";
import { timingSafeEqual } from "node:crypto";
import { createAuthorizationURL, validateAuthorizationCode } from "@better-auth/core/oauth2";
import type { OAuthProvider, ProviderOptions } from "@better-auth/core/oauth2";
import { createPlaceholderEmail } from "@better-auth/core/utils/email";
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify, type JWTPayload } from "jose";

/**
 * Telegram's OpenID Connect endpoints, fixed on purpose. The discovery
 * document at https://oauth.telegram.org/.well-known/openid-configuration is
 * never fetched, so a slow or unreachable Telegram cannot delay auth start-up
 * or take email sign-in down with it. If Telegram ever moves an endpoint,
 * change these constants and the spike fixture together.
 */
export const TELEGRAM_ISSUER = "https://oauth.telegram.org";
export const TELEGRAM_AUTH_URL = `${TELEGRAM_ISSUER}/auth`;
export const TELEGRAM_TOKEN_URL = `${TELEGRAM_ISSUER}/token`;
export const TELEGRAM_JWKS_URL = `${TELEGRAM_ISSUER}/.well-known/jwks.json`;
export const TELEGRAM_PROVIDER_ID = "telegram";

/** `openid` is mandatory; `profile` carries id, name, username and photo. Never `phone`. */
const TELEGRAM_SCOPES = ["openid", "profile"];
/** Telegram signs with RS256 unless the bot owner changes it in BotFather. */
const TELEGRAM_ALGORITHMS = ["RS256"];
/** An id_token is exchanged within seconds of being minted; older ones are replays or clock trouble. */
const ID_TOKEN_MAX_AGE = "10 minutes";
const PLACEHOLDER_NAMESPACE = "telegram";
const PLACEHOLDER_DOMAIN = "placeholder.invalid";

/** Claims Telegram puts in an id_token for the `openid profile` scopes. */
export type TelegramIdTokenClaims = {
  iss: string;
  aud: string | string[];
  sub: string;
  iat: number;
  exp: number;
  nonce?: string;
  /** Numeric Telegram user id, at most 52 significant bits. Present with the `profile` scope. */
  id?: number;
  name?: string;
  given_name?: string;
  family_name?: string;
  preferred_username?: string;
  picture?: string;
};

export type TelegramProviderEnv = {
  clientId: string;
  clientSecret: string;
  redirectURI?: string;
  /** Receives one diagnostic line per rejected id_token (never the token or its claims). Defaults to console.warn. */
  warn?: (message: string) => void;
};

/** Stable prefix for the rejection diagnostics, so they can be found in production logs. */
export const TELEGRAM_REJECTION_LOG_PREFIX = "hq-telegram: id_token rejected:";

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const code = "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
  return `${error.name}${code}: ${error.message}`;
}

/**
 * True for the internal non-deliverable identifier that stands in for an
 * email on Telegram-only accounts (`<sub>@telegram.placeholder.invalid`), and
 * for anything else on the library's reserved `placeholder.invalid` domain.
 * Such an address is never mailed, never displayed and never synced as a contact.
 */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domain === PLACEHOLDER_DOMAIN || domain.endsWith(`.${PLACEHOLDER_DOMAIN}`);
}

/**
 * The placeholder for a Telegram subject. Better Auth requires every user to
 * have a string email; Telegram supplies none. This is the library's own
 * convention for that case (also used by its anonymous and SIWE plugins): a
 * stable address on the RFC 6761 `.invalid` TLD that can never resolve. It is
 * stored with emailVerified false and is not what makes an HQ account
 * verified; the hq_auth_telegram_identity row is.
 */
export function telegramPlaceholderEmail(sub: string): string {
  return createPlaceholderEmail({ identifier: sub, namespace: PLACEHOLDER_NAMESPACE });
}

/** Narrows a decoded payload to the claim shape this provider relies on. */
export function parseTelegramClaims(payload: JWTPayload | Record<string, unknown>): TelegramIdTokenClaims | null {
  const { iss, aud, sub, iat, exp, nonce, id, name, given_name, family_name, preferred_username, picture } = payload as Record<string, unknown>;
  if (typeof iss !== "string" || typeof sub !== "string" || !sub) return null;
  if (typeof aud !== "string" && !(Array.isArray(aud) && aud.every((a) => typeof a === "string"))) return null;
  if (typeof iat !== "number" || typeof exp !== "number") return null;
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  return {
    iss, aud: aud as string | string[], sub, iat, exp,
    nonce: text(nonce),
    id: typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined,
    name: text(name), given_name: text(given_name), family_name: text(family_name),
    preferred_username: text(preferred_username), picture: text(picture),
  };
}

/**
 * Reads the claims of an id_token that has ALREADY been verified by
 * getUserInfo (the only path that stores one on a telegram account). No
 * signature check happens here; callers must only pass tokens taken from an
 * hq_auth_account row written by this provider.
 */
export function readTelegramClaims(idToken: string): TelegramIdTokenClaims | null {
  try {
    return parseTelegramClaims(decodeJwt(idToken));
  } catch {
    return null;
  }
}

function nonceMatches(claim: unknown, expected: string): boolean {
  if (typeof claim !== "string") return false;
  const a = Buffer.from(claim);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** Created on first use, fetched on first verification, cached by jose. Never touched at init. */
function telegramJwks() {
  remoteJwks ??= createRemoteJWKSet(new URL(TELEGRAM_JWKS_URL), {
    [customFetch]: async (url, init) => {
      const response = await fetch(url, { ...init, redirect: "manual" });
      if (response.type === "opaqueredirect" || REDIRECT_STATUSES.has(response.status)) {
        throw new Error("The Telegram JWKS endpoint answered with a redirect, which is refused.");
      }
      return response;
    },
  });
  return remoteJwks;
}

/**
 * A static OAuthProvider for Telegram's OIDC login. Authorization Code with
 * PKCE S256, server-side state and nonce, client_secret_basic at the token
 * endpoint (plus client_id in the body, as Telegram's docs show), and a
 * server-side id_token check. There is no userinfo endpoint, so the verified
 * id_token is the profile. Construction performs no I/O.
 */
export function telegramProvider(env: TelegramProviderEnv): OAuthProvider<TelegramIdTokenClaims, Partial<ProviderOptions<TelegramIdTokenClaims>>> {
  const options: Partial<ProviderOptions<TelegramIdTokenClaims>> = {
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    redirectURI: env.redirectURI,
    // Closes /sign-in/social and /link-social to client-supplied id_tokens at
    // the library level; the identity plugin closes them a second time.
    disableIdTokenSignIn: true,
  };
  const warn = env.warn ?? ((message: string) => console.warn(message));
  // The core callback collapses every null into `unable_to_get_user_info`;
  // this line is what makes a live rejection diagnosable. Reasons only.
  const rejected = (reason: string): null => {
    warn(`${TELEGRAM_REJECTION_LOG_PREFIX} ${reason}`);
    return null;
  };
  return {
    id: TELEGRAM_PROVIDER_ID,
    name: "Telegram",
    issuer: TELEGRAM_ISSUER,
    accountIssuer: TELEGRAM_ISSUER,
    accountSubject: ({ profile }) => profile.sub,
    requiresIdTokenNonce: true,
    options,
    // Scopes and parameters are fixed here; the client body's `scopes` and
    // `additionalParams` are deliberately ignored so nothing can add `phone`.
    createAuthorizationURL: ({ state, codeVerifier, redirectURI, idTokenNonce }) =>
      createAuthorizationURL({
        id: TELEGRAM_PROVIDER_ID,
        options,
        authorizationEndpoint: TELEGRAM_AUTH_URL,
        state,
        codeVerifier,
        scopes: TELEGRAM_SCOPES,
        redirectURI,
        nonce: idTokenNonce,
      }),
    validateAuthorizationCode: ({ code, codeVerifier, redirectURI }) =>
      validateAuthorizationCode({
        code,
        codeVerifier,
        redirectURI,
        options,
        tokenEndpoint: TELEGRAM_TOKEN_URL,
        authentication: "basic",
        additionalParams: { client_id: env.clientId },
      }),
    async getUserInfo({ idToken, expectedIdTokenNonce }) {
      // Both are mandatory: no nonce means no redirect flow of ours started this login.
      if (!idToken) return rejected("the token response carried no id_token");
      if (!expectedIdTokenNonce) return rejected("no server nonce in the OAuth state");
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(idToken, telegramJwks(), {
          issuer: TELEGRAM_ISSUER,
          audience: env.clientId,
          algorithms: TELEGRAM_ALGORITHMS,
          maxTokenAge: ID_TOKEN_MAX_AGE,
        }));
      } catch (error) {
        return rejected(`verification failed: ${describeError(error)}`);
      }
      if (!nonceMatches(payload.nonce, expectedIdTokenNonce)) return rejected("nonce does not match the OAuth state");
      const claims = parseTelegramClaims(payload);
      if (!claims) return rejected("claims lack iss, aud, sub, iat or exp in the expected types");
      return {
        user: {
          name: claims.name,
          image: claims.picture,
          // Telegram verified a Telegram account, not an email. See telegramPlaceholderEmail.
          email: telegramPlaceholderEmail(claims.sub),
          emailVerified: false,
        },
        data: claims,
      };
    },
  };
}
