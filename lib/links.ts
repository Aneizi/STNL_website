/**
 * Single source of truth for outbound destinations.
 * "events" is the Luma calendar (RSVP targets); the /events page itself is internal.
 * Earn/Join/social targets are provisional — to be wired to final URLs later.
 */
export const LINKS = {
  events: "https://luma.com/stnl",
  earn: "https://superteam.fun/earn/s/superteamnetherlands",
  join: "https://t.me/+Cn9PvQtQW5tmY2Jk",
  x: "https://x.com/SuperteamNL",
  linkedin: "https://www.linkedin.com/company/superteam_nl",
  instagram: "https://www.instagram.com/superteamnld/",
  telegram: "https://t.me/+Cn9PvQtQW5tmY2Jk",
} as const;
