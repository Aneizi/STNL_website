import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ColosseumFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ColosseumErrorCode =
  | "INVALID_URL" | "UNAVAILABLE" | "NOT_FOUND" | "RATE_LIMITED"
  | "INVALID_RESPONSE" | "WRONG_HACKATHON" | "TOO_MANY_COMMENTS";

const errorMessages: Record<ColosseumErrorCode, string> = {
  INVALID_URL: "Paste a Colosseum project link, such as https://colosseum.com/arena/projects/explore/your-project.",
  UNAVAILABLE: "Colosseum is unavailable right now. Try again shortly or request a manual review.",
  NOT_FOUND: "This project is not available on Colosseum yet. Check the link or request a manual review.",
  RATE_LIMITED: "Colosseum is receiving too many requests. Wait a minute and try again.",
  INVALID_RESPONSE: "We couldn't confirm this project's details with Colosseum. Please request a manual review.",
  WRONG_HACKATHON: "This project belongs to a different hackathon. Use a project registered for the selected hackathon.",
  TOO_MANY_COMMENTS: "We couldn't check every comment. Please request a manual review.",
};

export class ColosseumApiError extends Error {
  constructor(public readonly code: ColosseumErrorCode) {
    super(errorMessages[code]);
    this.name = "ColosseumApiError";
  }
}

export type ImportedProject = {
  externalId: number;
  slug: string;
  name: string;
  country: string | null;
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

export type ColosseumComment = {
  id: number;
  projectId: number;
  user: { id: number; username: string };
  text: string;
  createdAt: string;
  isDeleted: boolean;
};

export type ProjectProof = { commentId: number; authorId: number; username: string };

const API_ORIGIN = "https://api.colosseum.com";
const MAX_BODY_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 6_000;
const COMMENT_BUDGET_MS = 15_000;
const MAX_COMMENT_PAGES = 5;
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/);
const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const usernameSchema = z.string().min(1).max(120).regex(/^\S+$/);
const optionalText = z.string().max(4_000).nullish();
const memberSchema = z.object({
  username: usernameSchema,
  displayName: z.string().max(250),
  avatarUrl: optionalText,
});
const projectSchema = z.object({
  projectType: z.literal("HACKATHON"),
  project: z.object({
    id: idSchema,
    hackathonId: idSchema,
    slug: slugSchema,
    name: z.string().trim().min(1).max(500),
    description: z.string().max(100_000),
    country: z.string().trim().max(120).nullish(),
    repoLink: optionalText,
    website: optionalText,
    presentationLink: optionalText,
    technicalDemoLink: optionalText,
    pitchVideoLink: optionalText,
    demoVideoLink: optionalText,
    image: z.object({ url: optionalText }).nullish(),
    hackathon: z.object({ id: idSchema, slug: slugSchema, name: z.string().min(1).max(250) }),
    teamMembers: z.array(memberSchema).min(1).max(100),
  }),
});

type RichTextNode = { type: string; text?: string; content?: RichTextNode[] };
const richTextSchema: z.ZodType<RichTextNode> = z.lazy(() => z.object({
  type: z.string().max(100),
  text: z.string().max(100_000).optional(),
  content: z.array(richTextSchema).max(2_000).optional(),
}));
const commentSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  user: z.object({ id: idSchema, username: usernameSchema }),
  body: richTextSchema,
  createdAt: z.iso.datetime({ offset: true }),
  isDeleted: z.boolean(),
});
const commentsPageSchema = z.object({
  comments: z.array(commentSchema).max(100),
  hasMore: z.boolean(),
  offset: z.number().int().nonnegative(),
});

export function parseColosseumProjectUrl(value: string): string {
  try {
    if (value.length > 2_048 || /[\\\u0000-\u0020]/.test(value.trim()) || value.includes("/../")) {
      throw new Error();
    }
    const url = new URL(value.trim());
    const match = /^\/arena\/projects\/explore\/([^/]+)\/?$/.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "colosseum.com" || url.port
      || url.username || url.password || !match) throw new Error();
    return slugSchema.parse(match[1]);
  } catch {
    throw new ColosseumApiError("INVALID_URL");
  }
}

// JSON is retained only as data. Limit depth before recursive rich-text validation.
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

async function readJson(url: URL, fetcher: ColosseumFetch, timeoutMs = REQUEST_TIMEOUT_MS): Promise<JsonValue> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(url, {
      method: "GET", headers: { Accept: "application/json" },
      cache: "no-store", redirect: "error", signal: controller.signal,
    });
    if (response.status === 404) throw new ColosseumApiError("NOT_FOUND");
    if (response.status === 429) throw new ColosseumApiError("RATE_LIMITED");
    if (!response.ok) throw new ColosseumApiError("UNAVAILABLE");
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
    throw new ColosseumApiError("UNAVAILABLE");
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

export async function fetchColosseumProject(
  url: string,
  fetcher: ColosseumFetch = fetch,
): Promise<ImportedProject> {
  const slug = parseColosseumProjectUrl(url);
  const apiUrl = new URL("/api/project", API_ORIGIN);
  apiUrl.searchParams.set("slug", slug);
  apiUrl.searchParams.set("type", "HACKATHON");
  const raw = await readJson(apiUrl, fetcher);
  const result = projectSchema.safeParse(raw);
  if (!result.success) throw new ColosseumApiError("INVALID_RESPONSE");
  const project = result.data.project;
  const usernames = project.teamMembers.map((member) => member.username.toLowerCase());
  if (project.slug !== slug || project.hackathon.id !== project.hackathonId
    || new Set(usernames).size !== usernames.length) throw new ColosseumApiError("INVALID_RESPONSE");
  return {
    externalId: project.id,
    slug: project.slug,
    name: project.name,
    country: project.country || null,
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

export function assertProjectHackathon(
  project: ImportedProject,
  expected: { externalId: number; slug: string },
): void {
  if (project.hackathon.id !== expected.externalId || project.hackathon.slug !== expected.slug) {
    throw new ColosseumApiError("WRONG_HACKATHON");
  }
}

function richText(node: RichTextNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const separator = ["doc", "bulletList", "orderedList", "listItem", "blockquote"].includes(node.type) ? "\n" : "";
  return node.content?.map(richText).join(separator) ?? "";
}

export async function fetchProjectComments(
  projectId: number,
  fetcher: ColosseumFetch = fetch,
): Promise<ColosseumComment[]> {
  if (!idSchema.safeParse(projectId).success) throw new ColosseumApiError("INVALID_RESPONSE");
  const comments: ColosseumComment[] = [];
  const seen = new Set<number>();
  const deadline = Date.now() + COMMENT_BUDGET_MS;
  let offset = 0;
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ColosseumApiError("UNAVAILABLE");
    const url = new URL("/api/project/comments", API_ORIGIN);
    url.searchParams.set("projectId", String(projectId));
    url.searchParams.set("offset", String(offset));
    const raw = await readJson(url, fetcher, Math.min(REQUEST_TIMEOUT_MS, remaining));
    const result = commentsPageSchema.safeParse(raw);
    if (!result.success || result.data.offset !== offset) throw new ColosseumApiError("INVALID_RESPONSE");
    const data = result.data;
    for (const comment of data.comments) {
      if (comment.projectId !== projectId) throw new ColosseumApiError("INVALID_RESPONSE");
      if (seen.has(comment.id)) continue;
      seen.add(comment.id);
      comments.push({
        id: comment.id, projectId: comment.projectId, user: comment.user,
        text: richText(comment.body).trim(), createdAt: comment.createdAt, isDeleted: comment.isDeleted,
      });
    }
    if (!data.hasMore) return comments;
    if (!data.comments.length) throw new ColosseumApiError("INVALID_RESPONSE");
    offset += data.comments.length;
  }
  throw new ColosseumApiError("TOO_MANY_COMMENTS");
}

export type ProjectChallenge = { code: string; issuedAt: Date | string; claimedUsername?: string };

function validChallenge(challenge: ProjectChallenge): boolean {
  const issuedAt = new Date(challenge.issuedAt).getTime();
  return /^\d{6,32}$/.test(challenge.code) && Number.isFinite(issuedAt) && issuedAt <= Date.now();
}

/** The returned snapshot is the one whose roster was checked against the proof. */
export async function verifyProjectClaim(
  project: ImportedProject,
  challenge: ProjectChallenge,
  fetcher: ColosseumFetch = fetch,
): Promise<{ project: ImportedProject; proof: ProjectProof | null }> {
  const current = await fetchColosseumProject(`https://colosseum.com/arena/projects/explore/${project.slug}`, fetcher);
  if (current.externalId !== project.externalId) throw new ColosseumApiError("INVALID_RESPONSE");
  assertProjectHackathon(current, { externalId: project.hackathon.id, slug: project.hackathon.slug });
  if (!validChallenge(challenge)) return { project: current, proof: null };
  const issuedAt = new Date(challenge.issuedAt).getTime();
  const members = new Set(current.members.map((member) => member.username.toLowerCase()));
  const claimed = challenge.claimedUsername?.toLowerCase();
  if (claimed !== undefined && !members.has(claimed)) return { project: current, proof: null };
  const comments = await fetchProjectComments(current.externalId, fetcher);
  const match = comments.find((comment) => {
    const username = comment.user.username.toLowerCase();
    const createdAt = Date.parse(comment.createdAt);
    return !comment.isDeleted && comment.projectId === current.externalId
      && comment.text === challenge.code && createdAt >= issuedAt && createdAt <= Date.now()
      && members.has(username) && (claimed === undefined || username === claimed);
  });
  return {
    project: current,
    proof: match ? { commentId: match.id, authorId: match.user.id, username: match.user.username } : null,
  };
}

export async function findProjectProof(
  project: ImportedProject,
  challenge: ProjectChallenge,
  fetcher: ColosseumFetch = fetch,
): Promise<ProjectProof | null> {
  if (!validChallenge(challenge)) return null;
  return (await verifyProjectClaim(project, challenge, fetcher)).proof;
}
