"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { IconArrowRight } from "symbols-react";
import { TINTS, type LedgerEvent, type PastLedgerEvent } from "@/lib/luma";
import { LINKS } from "@/lib/links";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange focus-visible:ring-offset-2 focus-visible:ring-offset-cream";

function countLabel(n: number) {
  return n === 1 ? "1 event" : `${n} events`;
}

function FeaturedCard({ event }: { event: LedgerEvent }) {
  return (
    <article
      className="my-3.5 flex flex-col overflow-hidden rounded-[18px] min-[700px]:flex-row"
      style={{ backgroundColor: event.tint }}
    >
      {event.img && (
        <div className="relative h-44 w-full flex-none min-[700px]:h-auto min-[700px]:w-[300px]">
          <Image
            src={event.img}
            alt=""
            fill
            sizes="(min-width: 700px) 300px, 100vw"
            className="object-cover"
          />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2.5 px-[30px] py-[26px]">
        <div className="flex items-center gap-2.5 font-mono text-[11.5px] font-semibold uppercase tracking-[0.08em]">
          {event.featured && (
            <span className="rounded-full bg-ink px-2.5 py-1 text-cream">
              Featured
            </span>
          )}
          <span className="text-ink/60">
            {event.dow} {event.day} {event.mon}
          </span>
        </div>
        <h3 className="font-serif text-[30px]/[1.08] font-normal text-ink [text-wrap:pretty]">
          {event.title}
        </h3>
        {event.blurb && (
          <p className="text-sm/[1.5] text-ink/[.62] [text-wrap:pretty]">
            {event.blurb}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-4">
          <a
            href={event.url}
            target="_blank"
            rel="noreferrer"
            className={`inline-flex items-center gap-2 rounded-full bg-ink px-[19px] py-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-cream transition-colors duration-200 hover:bg-orange ${FOCUS_RING}`}
          >
            RSVP
            <IconArrowRight
              aria-hidden="true"
              fill="currentColor"
              className="h-[10px] w-[12.5px]"
            />
            <span className="sr-only"> {event.title} (opens in new tab)</span>
          </a>
          <span className="font-mono text-[13px] font-medium text-ink/60">
            {event.time} / {event.venue ?? event.city}
          </span>
        </div>
      </div>
    </article>
  );
}

function EventRow({ event }: { event: LedgerEvent }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)_34px] items-center gap-4 rounded-lg border-b border-ink/10 px-2 py-[15px] transition-colors duration-150 hover:bg-[#F5EEE1] sm:grid-cols-[120px_minmax(0,1fr)_130px_34px]">
      <div className="flex items-baseline gap-[7px]">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">
          {event.dow}
        </span>
        <span className="font-serif text-[28px]/[normal] text-ink">
          {event.day}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[16.5px]/[1.25] font-semibold text-ink">
          {event.title}
        </h3>
        <div className="text-[13px] text-subtle">
          {event.venue ? `${event.venue} / ${event.city}` : event.city}
        </div>
      </div>
      <div className="hidden font-mono text-[13px] font-medium text-subtle sm:block">
        {event.time}
      </div>
      <a
        href={event.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`${event.title} on Luma (opens in new tab)`}
        className={`flex h-[34px] w-[34px] items-center justify-center text-ink transition-colors duration-200 hover:text-orange ${FOCUS_RING}`}
      >
        <IconArrowRight
          aria-hidden="true"
          fill="currentColor"
          className="h-[13px] w-[16px]"
        />
      </a>
    </div>
  );
}

export function EventsLedger({
  events,
  past,
  loadFailed = false,
}: {
  events: LedgerEvent[];
  past: PastLedgerEvent[];
  loadFailed?: boolean;
}) {
  const [city, setCity] = useState("All");

  // Only cities that actually have upcoming events, busiest first.
  const cities = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.city, (counts.get(e.city) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name);
  }, [events]);
  const showCityFilter = cities.length > 1;
  const activeCity = showCityFilter ? city : "All";

  const filtered =
    activeCity === "All" ? events : events.filter((e) => e.city === activeCity);
  // monthLabels arrive pre-sorted chronologically from the server.
  const months = [...new Set(filtered.map((e) => e.monthLabel))];
  const groups = months.map((month) => ({
    month,
    events: filtered.filter((e) => e.monthLabel === month),
  }));
  const pastFiltered =
    activeCity === "All" ? past : past.filter((e) => e.city === activeCity);

  // With one or two events on the calendar, promote them to featured-style
  // cards so they carry the page instead of two thin rows in empty space.
  const spotlight = events.length <= 2;

  // With little or nothing upcoming, open the archive so the page reads as
  // a full ledger instead of a mostly empty column.
  const [pastOpen, setPastOpen] = useState(spotlight);

  return (
    <div className="flex flex-col gap-10 px-6 pb-16 pt-8 min-[900px]:flex-row min-[900px]:gap-[60px] min-[900px]:px-14 min-[900px]:pb-16 min-[900px]:pt-[54px]">
      {/* Sidebar */}
      <div className="flex w-full flex-col gap-[22px] min-[900px]:w-[330px] min-[900px]:flex-none">
        <h1 className="font-serif text-[52px]/[0.98] font-normal tracking-[-0.01em] text-ink min-[900px]:text-[72px]/[0.98]">
          What&apos;s <em className="italic text-orange">on</em>
        </h1>
        <p className="text-base/[1.5] text-subtle [text-wrap:pretty]">
          Every Superteam NL gathering, in one calendar.
        </p>
        {showCityFilter && (
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Filter by city"
          >
            {["All", ...cities].map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={activeCity === name}
                onClick={() => setCity(name)}
                className={`whitespace-nowrap rounded-full border px-4 py-[9px] text-[12.5px] font-semibold tracking-[0.06em] transition-all duration-150 ${FOCUS_RING} ${
                  activeCity === name
                    ? "border-ink bg-ink text-cream"
                    : "border-ink/25 bg-transparent text-ink"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        )}
        <div className="hidden pt-[18px] min-[900px]:block">
          <div className="font-mono text-[11.5px] font-medium tracking-[0.06em] text-faded">
            synced with lu.ma/stnl
          </div>
        </div>
        {/* Grows with the ledger column (min/max keeps the crop pleasant)
            instead of a fixed height that forces a tall page when the
            calendar is quiet. */}
        <div className="relative mt-2 hidden max-h-[970px] min-h-[420px] flex-1 overflow-hidden rounded-2xl min-[900px]:flex">
          <Image
            src="/landing/city-illustration.png"
            alt=""
            fill
            sizes="330px"
            className="object-cover object-bottom"
          />
        </div>
      </div>

      {/* Ledger */}
      <div className="flex min-w-0 flex-1 flex-col">
        <p aria-live="polite" className="sr-only">
          {countLabel(filtered.length)} upcoming
          {activeCity === "All" ? "" : ` in ${activeCity}`}
        </p>

        {groups.map((g) => (
          <section key={g.month} className="mb-9 flex flex-col">
            <div className="mb-1 flex items-baseline gap-2.5 border-b-2 border-ink pb-2">
              <h2 className="font-serif text-[26px]/[normal] font-normal text-ink">
                {g.month}
              </h2>
              <span className="font-mono text-xs font-medium text-faded">
                {countLabel(g.events.length)}
              </span>
            </div>
            {g.events.map((e) =>
              e.featured || spotlight ? (
                <FeaturedCard
                  key={e.id}
                  event={
                    e.featured
                      ? e
                      : { ...e, tint: TINTS[filtered.indexOf(e) % TINTS.length] }
                  }
                />
              ) : (
                <EventRow key={e.id} event={e} />
              )
            )}
          </section>
        ))}

        {filtered.length === 0 && (
          <p className="py-11 font-serif text-[22px] text-subtle [text-wrap:pretty]">
            {loadFailed ? (
              <>
                The calendar couldn&apos;t load -{" "}
                <a
                  href={LINKS.events}
                  target="_blank"
                  rel="noreferrer"
                  className={`text-orange transition-colors hover:text-orange-deep ${FOCUS_RING}`}
                >
                  find everything on lu.ma/stnl{" "}
                  <IconArrowRight
                    aria-hidden="true"
                    fill="currentColor"
                    className="inline h-[0.55em] w-[0.69em]"
                  />
                  <span className="sr-only"> (opens in new tab)</span>
                </a>
              </>
            ) : (
              <>
                Nothing planned here yet -{" "}
                <a
                  href={LINKS.join}
                  target="_blank"
                  rel="noreferrer"
                  className={`text-orange transition-colors hover:text-orange-deep ${FOCUS_RING}`}
                >
                  propose an event{" "}
                  <IconArrowRight
                    aria-hidden="true"
                    fill="currentColor"
                    className="inline h-[0.55em] w-[0.69em]"
                  />
                  <span className="sr-only"> (opens in new tab)</span>
                </a>
              </>
            )}
          </p>
        )}

        {pastFiltered.length > 0 && (
          <section className="mt-3.5 flex flex-col">
            <div className="mb-1 flex items-baseline gap-2.5 border-b-2 border-ink/25 pb-2">
              <h2 className="font-serif text-[26px]/[normal] font-normal text-subtle">
                Past events
              </h2>
              <span className="font-mono text-xs font-medium text-faded">
                {countLabel(pastFiltered.length)}
              </span>
              <button
                type="button"
                aria-expanded={pastOpen}
                onClick={() => setPastOpen((o) => !o)}
                className={`ml-auto text-xs font-semibold uppercase tracking-[0.1em] text-subtle transition-colors duration-200 hover:text-orange ${FOCUS_RING}`}
              >
                {pastOpen ? "Hide −" : "Show +"}
                <span className="sr-only"> past events</span>
              </button>
            </div>
            {pastOpen &&
              pastFiltered.map((e) => (
                <div
                  key={e.id}
                  className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-4 border-b border-ink/[.08] px-2 py-[13px] sm:grid-cols-[120px_minmax(0,1fr)_130px]"
                >
                  <div className="flex items-baseline gap-[7px]">
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-faded">
                      {e.dow}
                    </span>
                    <span className="font-serif text-[26px]/[normal] text-subtle">
                      {e.day}
                    </span>
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-faded">
                      {e.mon}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <h3 className="text-[15.5px]/[1.25] font-semibold text-ink/55">
                      {e.title}
                    </h3>
                    <div className="text-[13px] text-faded">
                      {e.venue ? `${e.venue} / ${e.city}` : e.city}
                    </div>
                  </div>
                  <div className="hidden font-mono text-[13px] font-medium text-faded sm:block">
                    {e.time}
                  </div>
                </div>
              ))}
          </section>
        )}
      </div>
    </div>
  );
}
