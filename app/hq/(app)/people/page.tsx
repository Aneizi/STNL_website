import type { Metadata } from "next";
import { People } from "@/components/hq/people";
import { requireUser } from "@/lib/hq/auth";
import { getPartnerOptions, getPeople, getRoles } from "@/lib/hq/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "People" };

export default async function PeoplePage(props: {
  searchParams: Promise<{ reset?: string | string[] }>;
}) {
  const user = await requireUser();
  void user;
  const [people, partners, roles] = await Promise.all([
    getPeople(),
    getPartnerOptions(),
    getRoles(),
  ]);
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
