import { cookies } from "next/headers";
import { COLOSSEUM_INTEREST_COOKIE, COLOSSEUM_INTEREST_COOKIE_VALUE, type InterestPath } from "@/lib/colosseum-interest";
import { InterestForm } from "./interest-form";

export async function SavedInterestForm({ path }: { path: InterestPath }) {
  const cookieStore = await cookies();
  const completed = cookieStore.get(COLOSSEUM_INTEREST_COOKIE)?.value === COLOSSEUM_INTEREST_COOKIE_VALUE;
  return <InterestForm key={path} path={path} completed={completed} />;
}
