/**
 * Banner artwork per hackathon, keyed by slug. The picker (/hq/select) paints
 * a hackathon with artwork as its background with the wordmark laid over it;
 * one without falls back to a typographic banner. Artwork is committed under
 * public/hackathons (not public/hq: the auth guard on /hq would answer for
 * it), so this is the one place a hackathon is named in code — and only to
 * find its pictures, never its data.
 */
export type HackathonArt = {
  /** Background painting, 3:1. */
  background: string;
  /** Transparent wordmark, laid over the background. */
  wordmark: string;
  /** What the wordmark says, for assistive tech. */
  wordmarkAlt: string;
  /** Wordmark width as a fraction of the banner width. */
  wordmarkWidth: number;
};

const ART: Record<string, HackathonArt> = {
  "colosseum-worlds-fair": {
    background: "/hackathons/worlds-fair.jpg",
    wordmark: "/hackathons/worlds-fair-wordmark.png",
    wordmarkAlt: "Crypto World's Fair",
    wordmarkWidth: 0.56,
  },
};

export function hackathonArt(slug: string): HackathonArt | null {
  return ART[slug] ?? null;
}
