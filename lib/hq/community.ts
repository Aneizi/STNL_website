/**
 * Community destinations HQ links out to. Client-safe constants only: no
 * `server-only`, no environment, nothing but strings, so a client component
 * and a server page can both import them and the link can never be written
 * out twice and drift.
 */

/**
 * The Superteam NL Telegram group. Phase 3's "already imported" outcome
 * routes the importer here for help instead of to a retry, and the plan is
 * explicit about how: rendered as a **Telegram logo control with an
 * accessible name**, never as a bare URL and never with the raw invite string
 * as link text.
 */
export const SUPERTEAM_NL_TELEGRAM_GROUP = "https://t.me/+XDJmVCvfB-oyMDA8";

/** The accessible name that control carries. One spelling, used by every renderer of it. */
export const SUPERTEAM_NL_TELEGRAM_GROUP_LABEL = "Ask for help in the Superteam NL Telegram group";
