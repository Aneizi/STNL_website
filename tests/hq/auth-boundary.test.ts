// The HQ auth boundary lives in every page, server action, and route
// handler (layouts don't re-render on soft navigation). These checks scan
// the source so an accidentally unguarded surface fails CI instead of
// shipping.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

type Gate = "operator" | "member";

// The two session origins and their gate spellings. The operator gate is
// requireUser (redirects), currentUser (the null-guard variant for surfaces
// that respond instead of redirecting) or the actor wrapper over them; the
// member gate is requireMember, currentMember or the member actor wrapper.
// A public account never passes an operator gate and vice versa.
const GATES: Record<Gate, RegExp> = {
  operator: /\b(requireUser|currentUser|requireOperatorActor)\(/,
  member: /\b(requireMember|currentMember|requireMemberActor)\(/,
};

describe("every /hq page and route handler checks the session", () => {
  const files = walk(join(ROOT, "app/hq")).filter(
    (file) => file.endsWith("page.tsx") || file.endsWith("route.ts"),
  );

  it("finds the HQ surface", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    it(relative(ROOT, file), () => {
      const source = readFileSync(file, "utf8");
      const isMember = relative(ROOT, file).startsWith("app/hq/(member)/");
      expect(source).toMatch(isMember ? GATES.member : GATES.operator);
    });
  }
});

describe("every server action authenticates", () => {
  // Every "use server" module under lib/hq/actions and the gate each of its
  // exports must call. A new module must be added here with its gate: an
  // unknown file fails, and so does a mapped file that no longer exists.
  const ACTION_GATES: Record<string, Gate> = {
    "admin.ts": "operator",
    "auth.ts": "operator",
    "builders-admin.ts": "operator",
    "builders.ts": "member",
    "capabilities.ts": "operator",
    "captains.ts": "operator",
    "demo.ts": "operator",
    "events.ts": "operator",
    "hackathons.ts": "operator",
    "invite.ts": "member",
    // Phase 8's authenticated manual retry of the scheduled reminder and
    // closure pass, beside the OIDC-authenticated /api/cron/hq-jobs run.
    "jobs.ts": "operator",
    "links.ts": "operator",
    "overlay.ts": "operator",
    "partners.ts": "operator",
    "people.ts": "operator",
    "projects.ts": "operator",
    // Weekly reporting, phase 6: the member writes (team and Captain
    // composers, the two contacts) and the admin ones (moderation, outcome
    // corrections, eligibility, the schedule and the Projects panel reads).
    // Two modules because the gates differ, the same split as
    // captains.ts / invite.ts.
    "reporting.ts": "member",
    "reporting-admin.ts": "operator",
    "telegram.ts": "member",
  };

  // login is the rate-limited public entry point; logout only destroys the
  // caller's own session.
  const PUBLIC = new Set(["auth.ts:login", "auth.ts:logout"]);

  const files = walk(join(ROOT, "lib/hq/actions")).filter((file) => {
    if (!file.endsWith(".ts")) return false;
    return readFileSync(file, "utf8").startsWith('"use server"');
  });

  it("finds the action modules", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it("maps every action module to a gate, and only existing modules", () => {
    expect(files.map((file) => basename(file)).sort()).toEqual(Object.keys(ACTION_GATES).sort());
  });

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const gate = ACTION_GATES[basename(file)];
    const matches = [...source.matchAll(/export async function (\w+)/g)];
    for (const [index, match] of matches.entries()) {
      const name = `${basename(file)}:${match[1]}`;
      if (PUBLIC.has(name)) continue;
      const body = source.slice(
        match.index,
        index + 1 < matches.length ? matches[index + 1].index : source.length,
      );
      it(name, () => {
        expect(gate, `${basename(file)} is not in the gate map`).toBeDefined();
        expect(body).toMatch(GATES[gate]);
      });
    }
  }
});

/**
 * The Telegram webhook is a third door into HQ and it is protected
 * independently of the other two (the plan: "Protect the bot webhook and job
 * endpoint independently. An authenticated bot request is not an admin
 * session."). It carries no cookie, no operator session and no member
 * session; the account behind an update comes from the verified Telegram
 * identity row, read on every request. The scan below is what keeps a future
 * change from quietly giving it one, or from dropping the secret check.
 */
describe("the Telegram webhook is its own boundary", () => {
  const ROUTE = join(ROOT, "app/api/telegram/webhook/route.ts");
  const MODULE = join(ROOT, "lib/hq/telegram-webhook.ts");

  it("holds no session of either kind", () => {
    for (const file of [ROUTE, MODULE]) {
      const source = readFileSync(file, "utf8");
      expect(source, relative(ROOT, file)).not.toMatch(GATES.operator);
      expect(source, relative(ROOT, file)).not.toMatch(GATES.member);
      expect(source, relative(ROOT, file)).not.toMatch(/\bcookies\(\)/);
    }
  });

  it("authenticates with the dedicated webhook secret before anything else", () => {
    const source = readFileSync(MODULE, "utf8");
    expect(source).toMatch(/secretMatches\(config\.webhookSecret/);
    expect(source).toMatch(/status: 401/);
    // The size cap and the schema come before the payload is trusted.
    expect(source).toMatch(/MAX_WEBHOOK_BODY_BYTES/);
    expect(source).toMatch(/telegramUpdateSchema\.safeParse/);
  });

  it("answers an unconfigured deployment rather than opening a way in", () => {
    expect(readFileSync(MODULE, "utf8")).toMatch(/if \(!config\) return \{ status: 503/);
  });
});

/**
 * The scheduled job endpoint is the fourth door, and the plan puts it beside
 * the webhook: "Protect the bot webhook and job endpoint independently. An
 * authenticated bot request is not an admin session." It carries no cookie
 * and no session of either kind; the caller is GitHub's own short-lived OIDC
 * identity, minted for this job's audience by this job's workflow file, and
 * verified before any work runs.
 */
describe("the scheduled job endpoint is its own boundary", () => {
  const ROUTE = join(ROOT, "app/api/cron/hq-jobs/route.ts");
  const MODULE = join(ROOT, "lib/hq/jobs.ts");

  it("holds no session of either kind", () => {
    for (const file of [ROUTE, MODULE]) {
      const source = readFileSync(file, "utf8");
      expect(source, relative(ROOT, file)).not.toMatch(GATES.operator);
      expect(source, relative(ROOT, file)).not.toMatch(GATES.member);
      expect(source, relative(ROOT, file)).not.toMatch(/\bcookies\(\)/);
    }
  });

  it("verifies the job identity before any work runs, and answers 401 otherwise", () => {
    const source = readFileSync(ROUTE, "utf8");
    const guard = source.indexOf("isTrustedHqJobsRequest");
    const work = source.indexOf("runDueWork(");
    expect(guard).toBeGreaterThan(-1);
    expect(work).toBeGreaterThan(guard);
    expect(source).toMatch(/status: 401/);
  });

  it("uses its own audience and its own workflow file, not the Luma sync's", () => {
    const auth = readFileSync(join(ROOT, "lib/hq/github-actions-auth.ts"), "utf8");
    expect(auth).toMatch(/HQ_JOBS_AUDIENCE = "stnl-hq-jobs"/);
    expect(auth).toMatch(/HQ_JOBS_JOB: ScheduledJob = \{ audience: HQ_JOBS_AUDIENCE, workflow: "hq-jobs\.yml" \}/);
    const workflow = readFileSync(join(ROOT, ".github/workflows/hq-jobs.yml"), "utf8");
    expect(workflow).toContain("audience=stnl-hq-jobs");
    expect(workflow).toContain("/api/cron/hq-jobs");
    // No shared secret travels with this job, so none can be committed by
    // accident or read out of a workflow log.
    expect(workflow).not.toMatch(/secrets\./);
  });
});
