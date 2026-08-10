"use client";

import { useRouter } from "next/navigation";
import {
  startTransition,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { FormField, input, pageTitle } from "@/components/hq/ui";
import { createEvent, updateEvent } from "@/lib/hq/actions/events";
import { fmtDate, fmtMoney } from "@/lib/hq/format";
import type { Classifiers, HqEvent, Settings } from "@/lib/hq/types";

type EventField = Parameters<typeof updateEvent>[1];

const GRID =
  "132px minmax(0,1.4fr) 110px minmax(0,1.5fr) minmax(0,1.3fr) 70px 62px 84px 150px 40px";

const OUTPUT_TOOLTIP =
  "Qualified teams / active teams / verified submissions. Derived from tracked projects; each team counts once, at the first event it appeared at.";

const rowGrid: CSSProperties = {
  display: "grid",
  textAlign: "left",
  overflowWrap: "break-word",
  gridTemplateColumns: GRID,
  gap: 10,
};

// Design's inline-edit inputs: 6px 8px on the tinted row (ui.editInput differs).
const editField: CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 8px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "var(--card)",
  color: "var(--label-1)",
  fontSize: 13,
};

const dateInput: CSSProperties = { ...input, padding: "7px 10px" };

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DOWS = ["M", "T", "W", "T", "F", "S", "S"];

function monthsBetween(calStart: string, calEnd: string): Array<{ y: number; m: number; label: string }> {
  const out: Array<{ y: number; m: number; label: string }> = [];
  const [sy, sm] = calStart.split("-").map(Number);
  const [ey, em] = calEnd.split("-").map(Number);
  if (!sy || !sm || !ey || !em) return out;
  let y = sy;
  let m = sm - 1;
  while ((y < ey || (y === ey && m <= em - 1)) && out.length < 36) {
    out.push({ y, m, label: `${MONTH_NAMES[m]} ${y}` });
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

const clampInt = (v: string) => Math.max(0, Math.round(Number(v) || 0));

export function Events(props: {
  events: HqEvent[];
  classifiers: Classifiers;
  settings: Settings;
  now: number;
  today: string;
  view?: string;
}) {
  const { events, classifiers, settings, today, view } = props;
  const router = useRouter();
  const [eventsView, setEventsView] = useState<"list" | "cal">("list");
  const [newEventOpen, setNewEventOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const drafts = useRef({ name: "", date: "", end: "", typeId: "", venue: "", cohost: "", spend: "" });

  // ⌘K navigation contract: a ?view=list arrival forces the list view.
  // State adjusts during render (React's prop-change pattern); only the
  // URL cleanup lives in the effect.
  const [prevView, setPrevView] = useState(view);
  if (view !== prevView) {
    setPrevView(view);
    if (view === "list") setEventsView("list");
  }
  useEffect(() => {
    if (view === "list") router.replace("/hq/events");
  }, [view, router]);

  const [optimistic, patchEvent] = useOptimistic(
    events,
    (state: HqEvent[], p: EventField & { id: string }) =>
      state.map((e) => (e.id === p.id ? ({ ...e, [p.field]: p.value } as HqEvent) : e)),
  );

  const commit = (id: string, field: EventField) => {
    startTransition(async () => {
      patchEvent({ id, ...field });
      await updateEvent(id, field);
    });
  };

  const addEvent = () => {
    const d = drafts.current;
    if (!d.name || !d.date) return;
    const payload = {
      name: d.name,
      date: d.date,
      endDate: d.end || null,
      typeId: d.typeId || classifiers.eventTypes[0]?.id || "",
      venue: d.venue,
      cohost: d.cohost,
      spend: clampInt(d.spend),
    };
    startTransition(async () => {
      await createEvent(payload);
    });
    drafts.current.name = drafts.current.date = drafts.current.end = "";
    setNewEventOpen(false);
  };

  const toggleEdit = (id: string) => setEditingId((cur) => (cur === id ? null : id));

  const typeById = (id: string) => classifiers.eventTypes.find((t) => t.id === id);

  const evs = optimistic.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const isPast = (e: HqEvent) => e.date <= today;

  const totalAttend = evs.reduce((s, e) => s + e.attendance, 0);
  const totalLeads = evs.reduce((s, e) => s + e.leads, 0);
  const totalSpend = fmtMoney(evs.reduce((s, e) => s + e.spend, 0));
  const totalOut = evs.reduce(
    (acc, e) => {
      if (!isPast(e)) return acc;
      acc.q += e.outputs.q;
      acc.a += e.outputs.a;
      acc.s += e.outputs.s;
      return acc;
    },
    { q: 0, a: 0, s: 0 },
  );

  const seg = (on: boolean): CSSProperties => ({
    border: "none",
    cursor: "pointer",
    padding: "5px 14px",
    borderRadius: 0,
    fontSize: 13,
    fontWeight: 600,
    background: on ? "var(--label-1)" : "none",
    color: on ? "var(--bg)" : "var(--label-2)",
  });

  const months = monthsBetween(settings.calStart, settings.calEnd).map(({ y, m, label }) => {
    const startPad = (new Date(y, m, 1).getDay() + 6) % 7;
    const daysIn = new Date(y, m + 1, 0).getDate();
    const cells: Array<{
      key: string;
      day: string;
      evt: string;
      bg: string;
      color: string;
      weight: number;
      title: string;
    }> = [];
    for (let i = 0; i < startPad; i++) {
      cells.push({ key: `p${i}`, day: "", evt: "", bg: "transparent", color: "var(--label-3)", weight: 400, title: "" });
    }
    for (let d = 1; d <= daysIn; d++) {
      const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const ev = optimistic.find(
        (e) => iso >= e.date && iso <= (e.endDate && e.endDate > e.date ? e.endDate : e.date),
      );
      cells.push({
        key: `d${d}`,
        day: String(d),
        evt: ev ? ev.name : "",
        bg: ev ? "var(--accent-fill)" : "transparent",
        color: ev ? "var(--accent-deep)" : "var(--label-2)",
        weight: ev ? 600 : 400,
        title: ev ? ev.name + (ev.venue ? `, ${ev.venue}` : "") : "",
      });
    }
    return { label, cells };
  });

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <h1 style={pageTitle}>
          Events <span style={{ fontWeight: 400, color: "var(--faded)" }}>{evs.length}</span>
        </h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", boxShadow: "0 0 0 1px var(--sep)", padding: 2 }}>
            <button onClick={() => setEventsView("list")} style={seg(eventsView === "list")}>
              List
            </button>
            <button onClick={() => setEventsView("cal")} style={seg(eventsView === "cal")}>
              Calendar
            </button>
          </div>
          <button
            onClick={() => setNewEventOpen((open) => !open)}
            style={{
              border: "none",
              cursor: "pointer",
              padding: "7px 14px",
              borderRadius: 0,
              fontSize: 14,
              fontWeight: 600,
              background: "var(--label-1)",
              color: "var(--bg)",
            }}
          >
            New event
          </button>
        </div>
      </div>
      {newEventOpen ? (
        <div
          className="hq-fade-in"
          style={{
            background: "var(--card)",
            borderRadius: 0,
            boxShadow: "var(--shadow-1)",
            padding: "16px 18px",
            marginTop: 14,
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            alignItems: "flex-end",
          }}
        >
          <FormField label="Event name" flex={1} minWidth={150}>
            <input onChange={(e) => (drafts.current.name = e.target.value)} style={input} />
          </FormField>
          <FormField label="Date" minWidth={130}>
            <input
              type="date"
              onChange={(e) => (drafts.current.date = e.target.value)}
              style={dateInput}
            />
          </FormField>
          <FormField label="End date" minWidth={130}>
            <input
              type="date"
              onChange={(e) => (drafts.current.end = e.target.value)}
              style={dateInput}
            />
          </FormField>
          <FormField label="Type" minWidth={180}>
            <select onChange={(e) => (drafts.current.typeId = e.target.value)} style={input}>
              {classifiers.eventTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Venue" flex={1} minWidth={130}>
            <input onChange={(e) => (drafts.current.venue = e.target.value)} style={input} />
          </FormField>
          <FormField label="Cohost" minWidth={130}>
            <input onChange={(e) => (drafts.current.cohost = e.target.value)} style={input} />
          </FormField>
          <FormField label="Budget $" width={100}>
            <input
              type="number"
              onChange={(e) => (drafts.current.spend = e.target.value)}
              style={input}
            />
          </FormField>
          <button
            onClick={addEvent}
            style={{
              border: "none",
              cursor: "pointer",
              padding: "9px 16px",
              borderRadius: 0,
              fontSize: 14,
              fontWeight: 600,
              background: "var(--label-1)",
              color: "var(--bg)",
            }}
          >
            Add
          </button>
        </div>
      ) : null}
      {eventsView === "list" ? (
        <div
          style={{
            background: "var(--card)",
            borderRadius: 0,
            boxShadow: "var(--shadow-1)",
            marginTop: 14,
            overflowX: "auto",
          }}
        >
          <div style={{ minWidth: 1120 }}>
            <div
              style={{
                ...rowGrid,
                padding: "10px 16px",
                borderBottom: "1px solid var(--sep)",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--label-3)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              <span>Date</span>
              <span>Event</span>
              <span>Type</span>
              <span>Venue</span>
              <span>Cohost</span>
              <span>Attend</span>
              <span>Leads</span>
              <span>Spend</span>
              <span
                title={OUTPUT_TOOLTIP}
                style={{
                  cursor: "help",
                  textDecoration: "underline dotted",
                  textUnderlineOffset: 3,
                }}
              >
                Output q / a / s
              </span>
            </div>
            {evs.map((e) => {
              const past = isPast(e);
              if (editingId !== e.id) {
                return (
                  <div
                    key={e.id}
                    style={{
                      ...rowGrid,
                      padding: "11px 16px",
                      borderBottom: "1px solid var(--sep)",
                      fontSize: 14,
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        fontVariantNumeric: "tabular-nums",
                        color: past ? "var(--label-3)" : "var(--label-1)",
                        fontSize: 13,
                        fontWeight: past ? 400 : 600,
                      }}
                    >
                      {e.endDate && e.endDate > e.date
                        ? `${fmtDate(e.date)} – ${fmtDate(e.endDate)}`
                        : fmtDate(e.date)}
                    </span>
                    <span style={{ fontWeight: 600 }}>{e.name}</span>
                    <span style={{ color: "var(--label-2)", fontSize: 13 }}>
                      {typeById(e.typeId)?.label ?? ""}
                    </span>
                    <span style={{ color: "var(--label-2)", fontSize: 13 }}>{e.venue}</span>
                    <span style={{ color: "var(--label-2)", fontSize: 13 }}>{e.cohost}</span>
                    <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--label-2)" }}>
                      {past ? e.attendance : ""}
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--label-2)" }}>
                      {past ? e.leads : ""}
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      {e.spend ? fmtMoney(e.spend) : ""}
                    </span>
                    <span
                      style={{
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--label-2)",
                        fontSize: 13,
                      }}
                    >
                      {past ? `${e.outputs.q} / ${e.outputs.a} / ${e.outputs.s}` : "upcoming"}
                    </span>
                    <button
                      className="hq-hover-accent"
                      onClick={() => toggleEdit(e.id)}
                      style={{
                        border: "none",
                        cursor: "pointer",
                        background: "none",
                        color: "var(--label-3)",
                        fontSize: 12,
                        padding: 2,
                        justifySelf: "start",
                      }}
                    >
                      Edit
                    </button>
                  </div>
                );
              }
              return (
                <div
                  key={e.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    alignItems: "center",
                    padding: "10px 16px",
                    borderBottom: "1px solid var(--sep)",
                    background: "var(--fill-4)",
                  }}
                >
                  <input
                    type="date"
                    defaultValue={e.date}
                    onChange={(ev) => {
                      if (ev.target.value) commit(e.id, { field: "date", value: ev.target.value });
                    }}
                    style={{ width: 140, flex: "none", ...editField }}
                  />
                  {typeById(e.typeId)?.supportsEndDate ? (
                    <>
                      <span style={{ fontSize: 12, color: "var(--label-3)", flex: "none" }}>to</span>
                      <input
                        type="date"
                        defaultValue={e.endDate ?? ""}
                        onChange={(ev) =>
                          commit(e.id, { field: "endDate", value: ev.target.value || null })
                        }
                        style={{ width: 140, flex: "none", ...editField }}
                      />
                    </>
                  ) : null}
                  <input
                    defaultValue={e.name}
                    onBlur={(ev) => {
                      if (ev.target.value.trim())
                        commit(e.id, { field: "name", value: ev.target.value.trim() });
                    }}
                    placeholder="Event name"
                    style={{ flex: 1, minWidth: 150, ...editField }}
                  />
                  <select
                    value={e.typeId}
                    onChange={(ev) => commit(e.id, { field: "typeId", value: ev.target.value })}
                    style={{
                      width: 190,
                      flex: "none",
                      padding: "6px 8px",
                      border: "1px solid var(--sep)",
                      borderRadius: 0,
                      background: "var(--card)",
                      color: "var(--label-1)",
                      fontSize: 13,
                    }}
                  >
                    {classifiers.eventTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <input
                    defaultValue={e.venue}
                    onBlur={(ev) => commit(e.id, { field: "venue", value: ev.target.value })}
                    placeholder="Venue"
                    style={{ flex: 1, minWidth: 120, ...editField }}
                  />
                  <input
                    defaultValue={e.cohost}
                    onBlur={(ev) => commit(e.id, { field: "cohost", value: ev.target.value })}
                    placeholder="Cohost"
                    style={{ width: 120, flex: "none", ...editField }}
                  />
                  <input
                    type="number"
                    min={0}
                    defaultValue={e.spend || 0}
                    onBlur={(ev) =>
                      commit(e.id, { field: "spend", value: clampInt(ev.target.value) })
                    }
                    placeholder="$"
                    style={{ width: 90, flex: "none", ...editField }}
                  />
                  <input
                    type="number"
                    min={0}
                    defaultValue={e.attendance}
                    onBlur={(ev) =>
                      commit(e.id, { field: "attendance", value: clampInt(ev.target.value) })
                    }
                    placeholder="att"
                    style={{ width: 90, flex: "none", ...editField }}
                  />
                  <input
                    type="number"
                    min={0}
                    defaultValue={e.leads}
                    onBlur={(ev) =>
                      commit(e.id, { field: "leads", value: clampInt(ev.target.value) })
                    }
                    placeholder="leads"
                    style={{ width: 90, flex: "none", ...editField }}
                  />
                  <button
                    onClick={() => toggleEdit(e.id)}
                    style={{
                      border: "none",
                      cursor: "pointer",
                      background: "none",
                      color: "var(--accent)",
                      fontSize: 12,
                      fontWeight: 600,
                      padding: 2,
                    }}
                  >
                    Done
                  </button>
                </div>
              );
            })}
            <div style={{ ...rowGrid, padding: "11px 16px", fontSize: 13, fontWeight: 600 }}>
              <span></span>
              <span>Total</span>
              <span></span>
              <span></span>
              <span></span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{totalAttend}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{totalLeads}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{totalSpend}</span>
              <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--label-2)" }}>
                {`${totalOut.q} / ${totalOut.a} / ${totalOut.s}`}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(290px,1fr))",
            gap: 12,
            marginTop: 14,
          }}
        >
          {months.map((m) => (
            <div
              key={m.label}
              style={{
                background: "var(--card)",
                borderRadius: 0,
                boxShadow: "var(--shadow-1)",
                padding: "16px 18px",
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>{m.label}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
                {DOWS.map((d, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 11,
                      color: "var(--label-3)",
                      textAlign: "center",
                      paddingBottom: 4,
                    }}
                  >
                    {d}
                  </div>
                ))}
                {m.cells.map((c) => (
                  <div
                    key={c.key}
                    title={c.title}
                    style={{ minHeight: 36, borderRadius: 0, padding: "2px 3px", background: c.bg }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        fontVariantNumeric: "tabular-nums",
                        color: c.color,
                        fontWeight: c.weight,
                      }}
                    >
                      {c.day}
                    </div>
                    <div
                      style={{
                        fontSize: 9,
                        lineHeight: "11px",
                        color: "var(--accent-deep)",
                        fontWeight: 600,
                        overflow: "hidden",
                      }}
                    >
                      {c.evt}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
