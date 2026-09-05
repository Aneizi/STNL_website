import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getHackathon } from "./queries";
import type { Hackathon } from "./types";

/**
 * Which hackathon the operator is working in.
 *
 * The choice lives in a cookie, not in the URL and not on the user row: every
 * /hq page then reads as before, just scoped, and switching costs one cookie
 * write. The value is only an id — nothing here is secret, and every operator
 * may open every hackathon — so a stale or forged value simply sends the
 * request back to the picker.
 */
const COOKIE = "hq_hackathon";
const MAX_AGE_S = 365 * 24 * 60 * 60;
const ID = /^[1-9]\d{0,8}$/;

/** The remembered hackathon id, or null. Cookie only: no database round trip. */
export async function selectedHackathonId(): Promise<number | null> {
  const store = await cookies();
  const value = store.get(COOKIE)?.value;
  return value && ID.test(value) ? Number(value) : null;
}

/**
 * The id every scoped page reads with. Pages start it before their reads,
 * then fetch the hackathon row *alongside* those reads and pass it through
 * ensureHackathon(), so a deleted hackathon costs no extra round trip to
 * detect. Without a choice there is nothing to render: back to the picker.
 */
export async function requireHackathonId(): Promise<number> {
  const id = await selectedHackathonId();
  if (!id) redirect("/hq/select");
  return id;
}

/** A cookie can outlive its hackathon; the picker is the only sensible place then. */
export function ensureHackathon(hackathon: Hackathon | null): Hackathon {
  if (!hackathon) redirect("/hq/select");
  return hackathon;
}

/** For actions that create records: the hackathon they belong to, verified. */
export async function requireHackathon(): Promise<Hackathon> {
  const id = await requireHackathonId();
  return ensureHackathon(await getHackathon(id));
}

export async function rememberHackathon(id: number) {
  const store = await cookies();
  store.set(COOKIE, String(id), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export async function forgetHackathon() {
  const store = await cookies();
  store.delete(COOKIE);
}
