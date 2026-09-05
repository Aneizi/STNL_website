"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { COLOSSEUM_SIGNUP_URL } from "@/lib/colosseum";
import { parseInterestForm, type InterestResult } from "@/lib/colosseum-interest";
import { getSql } from "@/lib/hq/db";
import { saveColosseumInterest } from "@/lib/hq/colosseum-interest";

export async function submitInterest(
  _previousState: InterestResult,
  formData: FormData,
): Promise<InterestResult> {
  const parsed = parseInterestForm(formData);
  if (!parsed.ok) return parsed.result;

  try {
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
    return {
      ok: true,
      redirectTo: parsed.data.path === "beginner"
        ? "/colosseum/start/beginner"
        : COLOSSEUM_SIGNUP_URL,
    };
  } catch {
    return { ok: false, error: "We couldn't save your interest. Please try again shortly." };
  }
}
