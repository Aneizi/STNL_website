import { z } from "zod";

/**
 * The one place the public Colosseum API's field names are written down.
 *
 * Phase 3 of `docs/plans/2026-09-13-hq-captains-and-colosseum.md` requires
 * that "the detail and listing parsers take their field names from one schema
 * module so a renamed field is a one-file change". This is that module: every
 * key `lib/colosseum-api.ts` reads is named here and nowhere else, so a
 * renamed upstream field is edited once, and the parser, the normalizer and
 * the tests all follow.
 *
 * What confirms these names: the shapes were observed on 2026-09-13 against
 * `https://api.colosseum.com` and are recorded, with their provenance and the
 * two explicit assumptions, in `tests/hq/fixtures/colosseum/README.md`. The
 * fixtures in that directory are validated against these schemas on every
 * test run, so a drift between this file and the recorded contract fails
 * before it reaches a builder.
 *
 * Pure: zod and nothing else. No `server-only`, no fetch, no database, so
 * tests and the normalizer can both import it.
 */

/** A project slug as it appears in a Colosseum project URL. */
export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/);
export const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const usernameSchema = z.string().min(1).max(120).regex(/^\S+$/);
const optionalText = z.string().max(4_000).nullish();

const memberSchema = z.object({
  username: usernameSchema,
  displayName: z.string().max(250),
  avatarUrl: optionalText,
});

/**
 * The edition block carried on a project. `id` and `slug` are the external
 * Colosseum identifiers: the admin-entered mapping in `hq_hackathon_onboarding`
 * is compared against them, and neither is ever hard coded in HQ.
 */
const projectHackathonSchema = z.object({
  id: idSchema,
  slug: slugSchema,
  name: z.string().min(1).max(250),
});

/**
 * One project, as both `GET /api/project` (inside `project`) and
 * `GET /api/projects` (inside `projects[]`) return it: the key set is the
 * same on both endpoints, which is why one schema serves both.
 *
 * Unknown keys are allowed through (zod objects are not strict here on
 * purpose) and survive only inside the retained raw snapshot. Optional fields
 * are `nullish` rather than required: "Missing optional fields must not make a
 * project unimportable".
 */
export const projectBodySchema = z.object({
  id: idSchema,
  hackathonId: idSchema,
  slug: slugSchema,
  name: z.string().trim().min(1).max(500),
  description: z.string().max(100_000),
  country: z.string().trim().max(120).nullish(),
  category: z.string().trim().max(200).nullish(),
  /** Legacy editions carried tracks; newer ones return an empty array. Never required. */
  tracks: z.array(z.string().max(200)).max(50).nullish(),
  repoLink: optionalText,
  website: optionalText,
  presentationLink: optionalText,
  technicalDemoLink: optionalText,
  pitchVideoLink: optionalText,
  demoVideoLink: optionalText,
  /** A handle, not a URL, and not necessarily the project's own account. Stored source-labelled. */
  twitterHandle: z.string().trim().max(120).nullish(),
  /**
   * The official submission signal. Non-null on every row observed live; its
   * value for a draft is an assumption, which is why
   * `lib/hq/colosseum-snapshot.ts#interpretSubmission` is the single place it
   * is turned into a status.
   */
  submittedAt: z.iso.datetime({ offset: true }).nullish(),
  image: z.object({ url: optionalText }).nullish(),
  hackathon: projectHackathonSchema,
  teamMembers: z.array(memberSchema).min(1).max(100),
});

/**
 * `projectCompletion` from the detail endpoint: a readiness diagnostic, never
 * a submission signal. The element type of `fieldErrors` was never observed
 * non-empty, so nothing here may assume the elements are strings — `unknown`
 * is deliberate and the normalizer keeps only the count.
 */
export const projectCompletionSchema = z.object({
  isComplete: z.boolean(),
  fieldErrors: z.array(z.unknown()).max(200).nullish(),
});

/** `GET /api/project?slug=...&type=HACKATHON`. */
export const projectDetailSchema = z.object({
  projectType: z.literal("HACKATHON"),
  project: projectBodySchema,
  projectCompletion: projectCompletionSchema.nullish(),
});

/**
 * The `hackathons` block of `GET /api/projects`. It is the only place the
 * submission window appears; `projectSubmissionEndDate` is the deadline a
 * submission time is compared against.
 */
export const listingHackathonSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(250),
  slug: slugSchema.nullish(),
  projectSubmissionStartDate: z.iso.datetime({ offset: true }).nullish(),
  projectSubmissionEndDate: z.iso.datetime({ offset: true }).nullish(),
  isProjectDirectoryEnabled: z.boolean().nullish(),
});

/**
 * `GET /api/projects?hackathonIds[]=...&sort=NAME` — the listing envelope,
 * read ONLY for its `hackathons` block.
 *
 * `projects` is deliberately `z.unknown()` rather than an array of
 * `projectBodySchema`. Observed live on 2026-09-14: a real Frontier project
 * carries the slug `""or""or`, which `slugSchema` rejects — and validating
 * the rows would make one pathological project anywhere in the page destroy
 * the edition's submission window for everyone. Nothing here reads a listing
 * row, so nothing here should be able to fail on one. The detail endpoint,
 * which HQ actually imports from, keeps its strict validation.
 */
export const listingSchema = z.object({
  projects: z.unknown(),
  hackathons: z.array(listingHackathonSchema).max(50),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  totalCount: z.number().int().nonnegative().nullish(),
});

/**
 * The error envelope every non-2xx body observed so far carries. Read so that
 * "directory disabled" and "unknown edition" stop being indistinguishable;
 * the values are treated as opaque text and are never rendered as markup.
 */
export const errorBodySchema = z.object({
  message: z.string().max(2_000).nullish(),
  code: z.string().max(200).nullish(),
});

export type ColosseumProjectBody = z.infer<typeof projectBodySchema>;
export type ColosseumListing = z.infer<typeof listingSchema>;
export type ColosseumListingHackathon = z.infer<typeof listingHackathonSchema>;
