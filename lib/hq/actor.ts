import "server-only";
import { cache } from "react";
import { currentUser, requireUser } from "./auth";
import { listActiveCapabilities, type Capability } from "./capabilities";
import { getTelegramIdentity } from "./identity";
import { currentMember, requireMember, type MemberSessionUser } from "./member-auth";

/**
 * The one authenticated actor representation the HQ services take.
 *
 * The two session origins stay distinct: an operator comes from the
 * operator session (`requireUser()`, hq_users) and a member from the public
 * account session (`currentMember()`, Better Auth). A public account never
 * becomes an operator, whatever it holds. `job` is reserved for the phase 8
 * job runner, whose verified OIDC token names an audience and nothing else.
 *
 * An actor id comes only from those validated sessions. Nothing here reads a
 * form field, a query parameter, a request body or a cookie of its own.
 */
export type Actor =
  | { kind: "operator"; id: string; displayName: string }
  | {
      kind: "member";
      id: string;
      name: string;
      email: string | null;
      /**
       * The account's active capabilities when this actor was built, for
       * presentation such as the member navigation. Authorization decisions
       * in ./authz read the grants again at decision time and never trust
       * this set.
       */
      capabilities: ReadonlySet<Capability>;
      /** The linked Telegram identity; `userId` is a string at every boundary. */
      telegram: { userId: string } | null;
    }
  | { kind: "job"; audience: string };

export type OperatorActor = Extract<Actor, { kind: "operator" }>;
export type MemberActor = Extract<Actor, { kind: "member" }>;

async function memberActor(user: MemberSessionUser): Promise<MemberActor> {
  const [capabilities, telegram] = await Promise.all([listActiveCapabilities(user.id), getTelegramIdentity(user.id)]);
  return {
    kind: "member",
    id: user.id,
    name: user.name,
    email: user.email,
    capabilities: new Set(capabilities),
    telegram: telegram ? { userId: telegram.telegramUserId } : null,
  };
}

/**
 * Whoever is signed in: the operator session first, else the member session,
 * else null. An operator who still has to change their password is not
 * handed an operator actor (`requireOperatorActor()` sends them to the
 * change-password page instead); such a request falls through to the member
 * session, which grants nothing operator-side.
 *
 * Wrapped in React `cache()` like `currentMember()`: a layout and a page in
 * the same request share one set of capability and identity reads. The
 * cache lives for that request only, never across requests, so a revocation
 * is visible on the next one.
 */
export const currentActor = cache(async (): Promise<Actor | null> => {
  const operator = await currentUser();
  if (operator && !operator.mustChangePassword) return { kind: "operator", id: operator.id, displayName: operator.displayName };
  const member = await currentMember();
  return member ? memberActor(member) : null;
});

/** The member gate: redirects like `requireMember()`, then builds the member actor. */
export async function requireMemberActor(next?: string): Promise<MemberActor> {
  return memberActor(await requireMember(next));
}

/** The operator gate: `requireUser()` with its redirects, as an actor. The only way to obtain `kind: "operator"`. */
export async function requireOperatorActor(): Promise<OperatorActor> {
  const user = await requireUser();
  return { kind: "operator", id: user.id, displayName: user.displayName };
}
