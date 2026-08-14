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
import { FormField, LumaMark, input, pageTitle } from "@/components/hq/ui";
import {
  archiveEvent,
  createEvent,
  deleteEvent,
  syncLuma,
  unarchiveEvent,
  unpinEventField,
  updateEvent,
} from "@/lib/hq/actions/events";
import { fmtAgo, fmtDate, fmtMoney } from "@/lib/hq/format";
import { PINNABLE, type PinnableField } from "@/lib/hq/luma-sync-sql";
import type { Classifiers, HqEvent, Settings } from "@/lib/hq/types";

type EventField = Parameters<typeof updateEvent>[1];

// Date · Event · Type · Venue · Cohost · Attend · Leads · Spend · Output · actions.
// The numeric columns are sized for their widest realistic value plus room to
// breathe, so a long figure never crowds the column beside it.
const GRID =
  "118px minmax(0,1.5fr) 120px minmax(0,1.5fr) minmax(0,1.3fr) 76px 68px 96px 150px 122px";

// Wide enough that a cell's content ends well before the next column starts,
// so a long name or a trailing Luma mark never reads as touching the column
// beside it.
const COLUMN_GAP = 20;

// The table scrolls inside its card rather than squeezing columns. Below this
// the text columns get narrow enough that most event names wrap to three lines,
// which costs more legibility than a horizontal scroll does.
const TABLE_MIN_WIDTH = 1400;

// Surface the last update time once it is old enough to be useful, while the
// daily workflow continues refreshing the mirror in the background.
const FRESHNESS_STATUS_AFTER_MS = 3 * 60 * 60 * 1000;

const OUTPUT_TOOLTIP =
  "Qualified teams / active teams / verified submissions. Derived from tracked projects; each team counts once, at the first event it appeared at.";

const rowGrid: CSSProperties = {
  display: "grid",
  textAlign: "left",
  overflowWrap: "break-word",
  gridTemplateColumns: GRID,
  columnGap: COLUMN_GAP,
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

/** Luma-backed fields, in row order, with labels for the override chips. */
const PIN_FIELDS: PinnableField[] = ["date", "endDate", "name", "venue", "cohost"];

const PIN_LABELS: Record<PinnableField, string> = {
  name: "name",
  date: "date",
  endDate: "end date",
  venue: "venue",
  cohost: "cohost",
};

/** Text buttons in the row's trailing actions column. */
const rowAction: CSSProperties = {
  border: "none",
  cursor: "pointer",
  background: "none",
  color: "var(--label-3)",
  fontSize: 12,
  padding: 2,
};

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
  /** Last successful Luma mirror refresh; null if it has never run. */
  syncedAt: string | null;
  view?: string;
}) {
  const { events, classifiers, settings, now, today, syncedAt, view } = props;
  const router = useRouter();
  const [eventsView, setEventsView] = useState<"list" | "cal">("list");
  const [newEventOpen, setNewEventOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // Inline two-step delete; a window.confirm would block the whole tab.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  // Deleted rows vanish immediately; useOptimistic cannot express a removal.
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(new Set());
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
    (state: HqEvent[], p: { id: string } & Partial<HqEvent>) =>
      state.map((e) => (e.id === p.id ? { ...e, ...p } : e)),
  );

  const commit = (id: string, field: EventField) => {
    startTransition(async () => {
      // Field names match HqEvent's keys, so the edit is also the patch.
      patchEvent({ id, [field.field]: field.value });
      await updateEvent(id, field);
    });
  };

  const setArchived = (id: string, archived: boolean) => {
    startTransition(async () => {
      patchEvent({ id, archived });
      await (archived ? archiveEvent(id) : unarchiveEvent(id));
    });
  };

  const removeEvent = (id: string) => {
    setConfirmingDelete(null);
    setDeletedIds((ids) => new Set(ids).add(id));
    startTransition(async () => {
      await deleteEvent(id);
    });
  };

  const releasePin = (id: string, field: PinnableField) => {
    startTransition(async () => {
      await unpinEventField(id, field);
    });
  };

  const runSync = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const result = await syncLuma();
      if (!result.ok) setSyncError(result.error ?? "Sync failed.");
    } catch {
      setSyncError("Could not sync Luma. Try again.");
    } finally {
      setSyncing(false);
    }
  };

  const syncedAgo = syncedAt ? fmtAgo(syncedAt, now) : "never synced";
  const syncedLabel = syncedAt ? `last synced ${syncedAgo}` : "never synced";
  const showFreshnessStatus =
    !syncedAt || now - Date.parse(syncedAt) > FRESHNESS_STATUS_AFTER_MS;

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

  // The comparator must return 0 for equal dates. Anything else is an
  // inconsistent comparator, whose result is implementation-defined — and the
  // server sorts under Node's V8 while the browser sorts under Chrome's, so
  // same-day events could land in different orders and break hydration.
  // Returning 0 also keeps the query's own `created_at` order for ties, since
  // Array#sort is stable.
  const sorted = optimistic
    .filter((e) => !deletedIds.has(e.id))
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
  const active = sorted.filter((e) => !e.archived);
  const archived = sorted.filter((e) => e.archived);
  // Archived events are out of the picture entirely: hidden behind the toggle
  // and absent from the calendar.
  const evs = showArchived ? archived : active;
  const isPast = (e: HqEvent) => e.date <= today;

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
      const ev = active.find(
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
          Events <span style={{ fontWeight: 400, color: "var(--faded)" }}>{active.length}</span>
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
          {archived.length > 0 ? (
            <button
              onClick={() => {
                setShowArchived((on) => !on);
                setEditingId(null);
              }}
              style={{
                border: "none",
                cursor: "pointer",
                padding: "7px 12px",
                borderRadius: 0,
                fontSize: 13,
                fontWeight: 600,
                background: showArchived ? "var(--fill-2)" : "none",
                color: "var(--label-2)",
                boxShadow: "0 0 0 1px var(--sep)",
              }}
            >
              Archived {archived.length}
            </button>
          ) : null}
          {showFreshnessStatus ? (
            <span
              style={{
                alignSelf: "center",
                padding: "6px 10px",
                fontSize: 12,
                fontWeight: 600,
                whiteSpace: "nowrap",
                background: "var(--accent-fill)",
                color: "var(--accent-deep)",
              }}
              title={`Luma events ${syncedLabel}. Use the refresh button to sync now.`}
            >
              {syncedAt ? `Updated ${syncedAgo}` : "Not updated yet"}
            </span>
          ) : null}
          <button
            onClick={() => void runSync()}
            disabled={syncing}
            aria-busy={syncing}
            aria-label={
              syncing ? "Syncing Luma events" : `Sync Luma events now — ${syncedLabel}`
            }
            title={syncing ? "Syncing Luma events…" : `Sync Luma events now — ${syncedLabel}`}
            style={{
              border: "none",
              cursor: syncing ? "progress" : "pointer",
              width: 40,
              height: 40,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              borderRadius: 0,
              background: "none",
              color: "var(--label-2)",
              boxShadow: "0 0 0 1px var(--sep)",
            }}
          >
            <svg
              className={syncing ? "hq-sync-icon hq-sync-icon-active" : "hq-sync-icon"}
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M20 6v5h-5M4 18v-5h5M5.6 9a7 7 0 0 1 11.9-2.5L20 9M4 15l2.5 2.5A7 7 0 0 0 18.4 15"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
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
      {syncError ? (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: "9px 14px",
            background: "var(--accent-fill)",
            color: "var(--accent-deep)",
            fontSize: 13,
          }}
        >
          {syncError}
        </div>
      ) : null}
      {showArchived ? (
        <div style={{ marginTop: 12, fontSize: 13, color: "var(--label-3)" }}>
          Archived events are hidden from the list and the calendar. Luma still holds
          them; archiving only affects HQ.
        </div>
      ) : null}
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
          <div style={{ minWidth: TABLE_MIN_WIDTH }}>
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
                    <span
                      style={{
                        fontWeight: 600,
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        minWidth: 0,
                      }}
                    >
                      <span style={{ overflowWrap: "anywhere" }}>{e.name}</span>
                      {e.lumaId ? <LumaMark href={e.lumaUrl} /> : null}
                    </span>
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
                    <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <button className="hq-hover-accent" onClick={() => toggleEdit(e.id)} style={rowAction}>
                        Edit
                      </button>
                      {e.archived ? (
                        <button
                          className="hq-hover-accent"
                          onClick={() => setArchived(e.id, false)}
                          style={rowAction}
                        >
                          Unarchive
                        </button>
                      ) : e.lumaId ? (
                        // A Luma row is never deletable: it would return on the
                        // next sync, minus everything HQ recorded against it.
                        <button
                          className="hq-hover-accent"
                          onClick={() => setArchived(e.id, true)}
                          style={rowAction}
                        >
                          Archive
                        </button>
                      ) : confirmingDelete === e.id ? (
                        <button
                          onClick={() => removeEvent(e.id)}
                          style={{ ...rowAction, color: "var(--accent)", fontWeight: 600 }}
                        >
                          Sure?
                        </button>
                      ) : (
                        <button
                          className="hq-hover-accent"
                          onClick={() => setConfirmingDelete(e.id)}
                          style={rowAction}
                        >
                          Delete
                        </button>
                      )}
                    </span>
                  </div>
                );
              }
              return (
                <div
                  key={e.id}
                  style={{
                    display: "flex",
                    gap: 12,
                    flexWrap: "wrap",
                    alignItems: "center",
                    padding: "12px 16px",
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
                  {e.lumaId && e.pinned.length > 0 ? (
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        flexWrap: "wrap",
                        fontSize: 11,
                        color: "var(--label-3)",
                      }}
                    >
                      <span>Overriding Luma:</span>
                      {PIN_FIELDS.filter((f) => e.pinned.includes(PINNABLE[f])).map((f) => (
                        <button
                          key={f}
                          onClick={() => releasePin(e.id, f)}
                          title={`Stop overriding ${PIN_LABELS[f]} — the next sync restores Luma's value`}
                          style={{
                            border: "1px solid var(--sep)",
                            cursor: "pointer",
                            background: "var(--card)",
                            color: "var(--label-2)",
                            borderRadius: 999,
                            fontSize: 11,
                            padding: "1px 8px",
                          }}
                        >
                          {PIN_LABELS[f]} ×
                        </button>
                      ))}
                    </span>
                  ) : null}
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
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            // min() so a month card never forces the page wider than the
            // viewport on narrow phones.
            gridTemplateColumns: "repeat(auto-fit,minmax(min(290px,100%),1fr))",
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
                    // Centered like the weekday header above it: both are 1fr
                    // columns with symmetric padding, so their centers line up.
                    style={{
                      minHeight: 36,
                      borderRadius: 0,
                      padding: "2px 3px",
                      background: c.bg,
                      textAlign: "center",
                    }}
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
                        overflowWrap: "anywhere",
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
