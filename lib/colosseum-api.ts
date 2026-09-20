import {
  errorBodySchema, idSchema, listingSchema, projectDetailSchema, projectUpdatesSchema, slugSchema,
  type ColosseumListingHackathon, type ColosseumProjectBody,
} from "./colosseum-schema";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ColosseumFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * One code per distinct failure, because phase 3 requires that "each of these
 * is a distinct, actionable, user-facing outcome. None may collapse into a
 * shared generic failure". In particular the transport failures below
 * (`TIMED_OUT`, `UNREACHABLE`, `RATE_LIMITED`, `INVALID_RESPONSE`,
 * `UNAVAILABLE`) are each separate from `NOT_FOUND` and each invite a retry,
 * rather than implying the project does not exist.
 *
 * `SOURCE_REJECTED` is the case the old adapter could not express at all: a
 * 4xx whose body carries Colosseum's own `code`/`message`, which is what tells
 * "directory disabled" apart from "unknown edition". The external text is
 * carried on the error as data (`sourceCode`, `sourceMessage`) for operator
 * surfaces and stored diagnostics; it is never the member-facing message and
 * is never rendered as markup.
 */
export type ColosseumErrorCode =
  | "INVALID_URL" | "NOT_FOUND" | "RATE_LIMITED" | "TIMED_OUT" | "UNREACHABLE"
  | "INVALID_RESPONSE" | "SOURCE_REJECTED" | "UNAVAILABLE" | "WRONG_HACKATHON";

const errorMessages: Record<ColosseumErrorCode, string> = {
  INVALID_URL: "That is not a Colosseum project link. Copy the link from your project page, such as https://colosseum.com/arena/projects/your-project.",
  NOT_FOUND: "Colosseum has no project at that link. Check the link on Colosseum, then try again.",
  RATE_LIMITED: "Colosseum is receiving too many requests right now. Wait a minute and try again — nothing is wrong with your project.",
  TIMED_OUT: "Colosseum took too long to answer. Your project is fine; try again in a moment.",
  UNREACHABLE: "We could not reach Colosseum just now. Your project is fine; try again in a moment.",
  INVALID_RESPONSE: "Colosseum answered with something we could not read. Your project is fine; try again in a moment.",
  SOURCE_REJECTED: "Colosseum refused that request. This is a problem on Colosseum's side, not with your project — try again in a moment.",
  UNAVAILABLE: "Colosseum is having trouble right now. Your project is fine; try again in a moment.",
  WRONG_HACKATHON: "This project belongs to a different hackathon than the one HQ is running.",
};

export class ColosseumApiError extends Error {
  constructor(
    public readonly code: ColosseumErrorCode,
    /** Colosseum's own error `code`, when the body carried one. Diagnostic data, never markup. */
    public readonly sourceCode: string | null = null,
    /** Colosseum's own error `message`, when the body carried one. Diagnostic data, never markup. */
    public readonly sourceMessage: string | null = null,
  ) {
    super(errorMessages[code]);
    this.name = "ColosseumApiError";
  }
}

/** Readiness from the detail endpoint. Never a submission signal; see lib/hq/colosseum-snapshot.ts. */
type ProjectCompletion = { isComplete: boolean; missingFieldCount: number };

export type ImportedProject = {
  externalId: number;
  slug: string;
  name: string;
  country: string | null;
  category: string | null;
  tracks: string[];
  /** A source-labelled handle. Never assumed to be the project's own account. */
  twitterHandle: string | null;
  /** The official submission signal, ISO or null. Interpreted in exactly one place. */
  submittedAt: string | null;
  /** Null for a listing row: `projectCompletion` is returned by the detail endpoint only. */
  completion: ProjectCompletion | null;
  hackathon: { id: number; slug: string; name: string };
  members: { username: string; displayName: string; avatarUrl: string | null }[];
  description: string;
  links: {
    repoLink: string | null;
    website: string | null;
    presentationLink: string | null;
    technicalDemoLink: string | null;
    pitchVideoLink: string | null;
    demoVideoLink: string | null;
  };
  imageUrl: string | null;
  raw: JsonValue;
};

/** The submission window of one edition, from the listing envelope's `hackathons` block. */
type EditionSubmissionWindow = {
  externalId: number;
  name: string;
  slug: string | null;
  submissionStart: string | null;
  submissionEnd: string | null;
  directoryEnabled: boolean | null;
};

const API_ORIGIN = "https://api.colosseum.com";
const MAX_BODY_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 6_000;

export function parseColosseumProjectUrl(value: string): string {
  try {
    const input = value.trim();
    // URL() removes literal and encoded dot segments. Refuse them before
    // normalization, while leaving harmless query strings/fragments alone.
    const pathBeforeNormalization = input.split(/[?#]/, 1)[0];
    if (value.length > 2_048 || /[\\\u0000- ]/.test(input)
      || /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(pathBeforeNormalization)) {
      throw new Error();
    }
    const url = new URL(input);
    // Accept shared project links and older saved /explore/<slug> links.
    // The bare /explore directory is not a project.
    const match = /^\/arena\/projects\/(explore\/)?([^/]+)\/?$/.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "colosseum.com" || url.port
      || url.username || url.password || !match || (!match[1] && match[2] === "explore")) throw new Error();
    return slugSchema.parse(match[2]);
  } catch {
    throw new ColosseumApiError("INVALID_URL");
  }
}

/** The public project URL stored by imports, source attachment and help requests. */
export function colosseumProjectUrl(slug: string): string {
  const validated = slugSchema.parse(slug);
  // Preserve the legacy path if the slug itself collides with the directory.
  return `https://colosseum.com/arena/projects/${validated === "explore" ? "explore/" : ""}${validated}`;
}

// JSON is retained only as data. Limit depth before recursive validation.
function checkJsonBounds(value: unknown): asserts value is JsonValue {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > 20_000 || item.depth > 40) throw new ColosseumApiError("INVALID_RESPONSE");
    if (item.value && typeof item.value === "object") {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
}

/** The response body as text, bounded by the same byte budget a success is. */
async function readBoundedText(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_BODY_BYTES) return null;
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * A non-2xx turned into the most precise code available. 404 and 429 keep
 * their own meaning; every other status now reads the body's `code`/`message`
 * instead of collapsing into `UNAVAILABLE`, which is what makes "directory
 * disabled" and "unknown edition" distinguishable to a caller.
 */
async function failureFor(response: Response): Promise<ColosseumApiError> {
  let code: string | null = null;
  let message: string | null = null;
  if (response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    const text = await readBoundedText(response);
    if (text !== null) {
      try {
        const parsed = errorBodySchema.safeParse(JSON.parse(text));
        if (parsed.success) {
          code = parsed.data.code ?? null;
          message = parsed.data.message ?? null;
        }
      } catch { /* An unreadable error body is simply no extra detail. */ }
    }
  }
  if (response.status === 404) return new ColosseumApiError("NOT_FOUND", code, message);
  if (response.status === 429) return new ColosseumApiError("RATE_LIMITED", code, message);
  if (response.status >= 400 && response.status < 500) return new ColosseumApiError("SOURCE_REJECTED", code, message);
  return new ColosseumApiError("UNAVAILABLE", code, message);
}

async function readJson(url: URL, fetcher: ColosseumFetch, timeoutMs = REQUEST_TIMEOUT_MS): Promise<JsonValue> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(url, {
      method: "GET", headers: { Accept: "application/json" },
      cache: "no-store", redirect: "error", signal: controller.signal,
    });
    if (!response.ok) throw await failureFor(response);
    if (response.redirected) throw new ColosseumApiError("INVALID_RESPONSE");
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new ColosseumApiError("INVALID_RESPONSE");
    }
    if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES || !response.body) {
      throw new ColosseumApiError("INVALID_RESPONSE");
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new ColosseumApiError("INVALID_RESPONSE");
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new ColosseumApiError("INVALID_RESPONSE"); }
    checkJsonBounds(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof ColosseumApiError) throw error;
    // A timeout and a refused connection are different things to the person
    // waiting, and neither means the project is missing.
    throw new ColosseumApiError(timedOut ? "TIMED_OUT" : "UNREACHABLE");
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => undefined);
  }
}

function safeWebLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** A handle as text: no leading @, no whitespace, never turned into a URL here. */
function handle(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^@+/, "").trim();
  return trimmed && !/\s/.test(trimmed) ? trimmed : null;
}

/** One project body (detail or listing row) as HQ stores it. */
function toImportedProject(
  project: ColosseumProjectBody,
  raw: JsonValue,
  completion: ProjectCompletion | null,
): ImportedProject {
  return {
    externalId: project.id,
    slug: project.slug,
    name: project.name,
    country: project.country || null,
    category: project.category?.trim() || null,
    tracks: (project.tracks ?? []).map((track) => track.trim()).filter(Boolean),
    twitterHandle: handle(project.twitterHandle),
    submittedAt: project.submittedAt ?? null,
    completion,
    hackathon: project.hackathon,
    members: project.teamMembers.map((member) => ({
      username: member.username,
      displayName: member.displayName || member.username,
      avatarUrl: safeWebLink(member.avatarUrl),
    })),
    description: project.description,
    links: {
      repoLink: safeWebLink(project.repoLink),
      website: safeWebLink(project.website),
      presentationLink: safeWebLink(project.presentationLink),
      technicalDemoLink: safeWebLink(project.technicalDemoLink),
      pitchVideoLink: safeWebLink(project.pitchVideoLink),
      demoVideoLink: safeWebLink(project.demoVideoLink),
    },
    imageUrl: safeWebLink(project.image?.url),
    raw,
  };
}

export async function fetchColosseumProject(
  url: string,
  fetcher: ColosseumFetch = fetch,
): Promise<ImportedProject> {
  const slug = parseColosseumProjectUrl(url);
  const apiUrl = new URL("/api/project", API_ORIGIN);
  apiUrl.searchParams.set("slug", slug);
  apiUrl.searchParams.set("type", "HACKATHON");
  const raw = await readJson(apiUrl, fetcher);
  const result = projectDetailSchema.safeParse(raw);
  if (!result.success) throw new ColosseumApiError("INVALID_RESPONSE");
  const project = result.data.project;
  const usernames = project.teamMembers.map((member) => member.username.toLowerCase());
  if (project.slug !== slug || project.hackathon.id !== project.hackathonId
    || new Set(usernames).size !== usernames.length) throw new ColosseumApiError("INVALID_RESPONSE");
  const completion = result.data.projectCompletion
    ? { isComplete: result.data.projectCompletion.isComplete, missingFieldCount: (result.data.projectCompletion.fieldErrors ?? []).length }
    : null;
  return toImportedProject(project, raw, completion);
}

export type ColosseumUpdate = {
  externalId: number;
  authorName: string;
  body: string;
  links: string[];
  sourceUrl: string;
  publishedAt: string;
  updatedAt: string;
};

/** Keep text and safe hyperlinks from Colosseum's rich-text document without
 * rendering upstream HTML or dropping video URLs embedded in link marks. */
function updateContent(value: unknown): { body: string; links: string[] } {
  const links = new Set<string>();
  const addLink = (value: unknown) => {
    const link = typeof value === "string" ? safeWebLink(value) : null;
    if (link) links.add(link);
  };
  function visit(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    const node = value as Record<string, unknown>;
    const attrs = node.attrs as Record<string, unknown> | undefined;
    if (attrs) { addLink(attrs.href); addLink(attrs.src); }
    if (Array.isArray(node.marks)) node.marks.forEach(visit);
    addLink(node.url);
    addLink(node.href);
    let text = typeof node.text === "string" ? node.text : "";
    if (Array.isArray(node.content)) text += node.content.map(visit).join("");
    if (node.type === "hardBreak") text += "\n";
    if (["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(String(node.type))) text += "\n";
    return text;
  }
  const body = visit(value).trim();
  // Plain pasted links are also common, including updates containing only a video.
  for (const match of body.matchAll(/https?:\/\/[^\s<>]+/g)) addLink(match[0].replace(/[.,;!?]+$/, ""));
  return { body, links: [...links] };
}

/** One cursor page, without a date cutoff: every sweep can recover old posts
 * and edits, including posts published before the project was imported. */
export async function fetchColosseumUpdatePage(
  input: { projectUrl: string; externalId: number; externalHackathonId: number | null; cursor?: string | null },
  fetcher: ColosseumFetch = fetch,
): Promise<{ updates: ColosseumUpdate[]; nextCursor: string | null }> {
  const slug = parseColosseumProjectUrl(input.projectUrl);
  const url = new URL(`/api/projects/by-slug/${slug}/build-logs`, API_ORIGIN);
  url.searchParams.set("limit", "20");
  if (input.cursor) url.searchParams.set("cursor", input.cursor);
  const parsed = projectUpdatesSchema.safeParse(await readJson(url, fetcher));
  if (!parsed.success) throw new ColosseumApiError("INVALID_RESPONSE");
  const { project, buildLogs, nextCursor } = parsed.data;
  if (project.id !== input.externalId || (input.externalHackathonId !== null && project.hackathonId !== input.externalHackathonId) || project.slug !== slug
    || buildLogs.some(update => update.projectId !== input.externalId)
    || new Set(buildLogs.map(update => update.id)).size !== buildLogs.length
    || (nextCursor !== null && (nextCursor === input.cursor || !buildLogs.length))) {
    throw new ColosseumApiError("INVALID_RESPONSE");
  }
  return {
    nextCursor,
    updates: buildLogs.map(update => {
      const content = updateContent(update.content);
      const links = new Set(content.links);
      for (const value of update.links ?? []) {
        if (typeof value === "string") {
          const link = safeWebLink(value);
          if (link) links.add(link);
        } else {
          for (const link of updateContent(value).links) links.add(link);
        }
      }
      const xUrl = safeWebLink(update.xUrl);
      if (xUrl) links.add(xUrl);
      return {
        externalId: update.id, authorName: update.author.displayName || update.author.username,
        body: content.body || update.excerpt || "", links: [...links],
        sourceUrl: `${colosseumProjectUrl(slug)}/updates/${update.id}`,
        publishedAt: new Date(update.publishedAt).toISOString(), updatedAt: new Date(update.updatedAt).toISOString(),
      };
    }),
  };
}

/**
 * The listing endpoint's `hackathons` envelope for one external edition: the
 * ONE function that reads `projectSubmissionEndDate`, per the plan's
 * instruction to keep each API-dependent part narrow and replaceable.
 *
 * What confirms it: the envelope was observed on the Frontier edition
 * (external id 6, directory enabled) on 2026-09-13 and re-confirmed live on
 * 2026-09-14, and is recorded in `tests/hq/fixtures/colosseum/listing.json`.
 * An edition whose directory is disabled answers 400 with
 * `code: "BAD_REQUEST"`, which surfaces as a `SOURCE_REJECTED` the caller can
 * tell apart from a missing edition (404, `NOT_FOUND`); neither is treated as
 * "no deadline".
 *
 * Two request details, both observed the hard way against the live API:
 * array parameters must use the bracket form (`hackathonIds[]=...`), and
 * **`sort` is required** — omitting it answers 400 "Invalid discriminator
 * value. Expected 'RANDOM' | 'NAME'", so this request would have failed every
 * single time without it. `NAME` is chosen over `RANDOM` because a stable
 * order makes a repeated read comparable; the rows themselves are not read.
 */
export async function fetchEditionSubmissionWindow(
  externalHackathonId: number,
  fetcher: ColosseumFetch = fetch,
): Promise<EditionSubmissionWindow | null> {
  if (!idSchema.safeParse(externalHackathonId).success) throw new ColosseumApiError("INVALID_RESPONSE");
  const url = new URL("/api/projects", API_ORIGIN);
  url.searchParams.append("hackathonIds[]", String(externalHackathonId));
  url.searchParams.set("sort", "NAME");
  const raw = await readJson(url, fetcher);
  const result = listingSchema.safeParse(raw);
  if (!result.success) throw new ColosseumApiError("INVALID_RESPONSE");
  const edition: ColosseumListingHackathon | undefined = result.data.hackathons.find((row) => row.id === externalHackathonId);
  if (!edition) return null;
  return {
    externalId: edition.id,
    name: edition.name,
    slug: edition.slug ?? null,
    submissionStart: edition.projectSubmissionStartDate ?? null,
    submissionEnd: edition.projectSubmissionEndDate ?? null,
    directoryEnabled: edition.isProjectDirectoryEnabled ?? null,
  };
}
