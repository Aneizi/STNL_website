import type { Metadata } from "next";
import { People } from "@/components/hq/people";
import { requireUser } from "@/lib/hq/auth";
import { ensureHackathon, requireHackathonId } from "@/lib/hq/hackathon";
import { getHackathon, getPartnerOptions, getPeople, getRoles } from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "People" };

export default async function PeoplePage(props: {
  searchParams: Promise<{ reset?: string | string[] }>;
}) {
  const hackathonId = await requireHackathonId();
  const [, hackathon, people, partners, roles] = await Promise.all([
    requireUser(),
    getHackathon(hackathonId),
    getPeople(hackathonId),
    getPartnerOptions(hackathonId),
    getRoles(),
  ]);
  ensureHackathon(hackathon);
  const { reset } = await props.searchParams;
  return (
    <People
      people={people}
      partners={partners}
      roles={roles}
      reset={Boolean(reset)}
    />
  );
}
