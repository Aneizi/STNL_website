import type { Metadata } from "next";
import Image from "next/image";
import { EventsLedger } from "@/components/events-ledger";
import { SiteHeader } from "@/components/site-header";
import { getPastEvents, getUpcomingEvents } from "@/lib/luma";

export const metadata: Metadata = {
  title: "Solana Events in the Netherlands",
  description:
    "Join Superteam NL (STNL) for Solana events in the Netherlands: community meetups, build stations and demo days. Find upcoming gatherings and RSVP.",
  alternates: { canonical: "/events" },
};

// Re-fetch the Luma calendar at most every 5 minutes.
export const revalidate = 300;

export default async function EventsPage() {
  const [upcoming, past] = await Promise.allSettled([
    getUpcomingEvents(),
    getPastEvents(),
  ]);

  return (
    <main className="flex min-h-dvh w-full flex-1 flex-col">
      {/* Mobile-only banner (bottom crop of the sidebar illustration),
          mirroring the About page's mobile image placement */}
      <div
        aria-hidden="true"
        className="relative h-[36vh] w-full [mask-image:linear-gradient(to_bottom,black_55%,transparent_100%)] min-[900px]:hidden"
      >
        <Image
          src="/landing/city-illustration.png"
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover object-bottom"
        />
      </div>
      <div className="px-6 pt-6 min-[900px]:px-14 min-[900px]:pt-[30px]">
        <SiteHeader active="events" />
      </div>
      <EventsLedger
        events={upcoming.status === "fulfilled" ? upcoming.value : []}
        past={past.status === "fulfilled" ? past.value : []}
        loadFailed={upcoming.status === "rejected"}
      />
    </main>
  );
}
