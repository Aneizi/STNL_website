"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import {
  COLOSSEUM_INTEREST_COOKIE, COLOSSEUM_INTEREST_COOKIE_VALUE,
  getInterestDestination, parseInterestForm, type InterestResult,
} from "@/lib/colosseum-interest";
import { getSql } from "@/lib/hq/db";
import { saveColosseumInterest } from "@/lib/hq/colosseum-interest";

export async function submitInterest(
  _previousState: InterestResult,
  formData: FormData,
): Promise<InterestResult> {
  const parsed = parseInterestForm(formData);
  if (!parsed.ok) return parsed.result;

  try {
    const cookieStore = await cookies();
    const redirectTo = getInterestDestination(parsed.data.path);
    if (cookieStore.get(COLOSSEUM_INTEREST_COOKIE)?.value === COLOSSEUM_INTEREST_COOKIE_VALUE) {
      return { ok: true, redirectTo };
    }

    const headerStore = await headers();
    // The deployment proxy supplies these headers, as for the HQ limiter.
    // Requests without an address share the same bounded fallback bucket.
    const source = headerStore.get("x-real-ip")
      ?? headerStore.get("x-forwarded-for")?.split(",")[0].trim()
      ?? "unknown";
    const sql = getSql();
    const result = await saveColosseumInterest(
      { query: (text, params) => sql.query(text, params) },
      parsed.data,
      source,
    );
    if (!result.ok) return result;

    revalidatePath("/hq", "layout");
    cookieStore.set(COLOSSEUM_INTEREST_COOKIE, COLOSSEUM_INTEREST_COOKIE_VALUE, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/colosseum",
      maxAge: 60 * 60 * 24 * 180,
    });
    return { ok: true, redirectTo };
  } catch {
    return { ok: false, error: "We couldn't save your interest. Please try again shortly." };
  }
}
