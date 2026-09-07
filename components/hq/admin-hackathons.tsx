"use client";

import { useRouter } from "next/navigation";
import type { CSSProperties } from "react";
import { useOptimistic, useRef, useState, useTransition } from "react";
import { FormField, card, cardTitle, input, primaryBtn, smallInput } from "@/components/hq/ui";
import { useConfirmDelete } from "@/components/hq/ui-client";
import { showToast } from "@/components/hq/toast";
import {
  addGate,
  archiveHackathon,
  createHackathon,
  deleteGate,
  deleteHackathon,
  renameGate,
  switchHackathon,
  unarchiveHackathon,
  updateHackathon,
} from "@/lib/hq/actions/hackathons";
import { fmtDateRange } from "@/lib/hq/hackathon-format";
import type { Gate, Hackathon } from "@/lib/hq/types";

const field: CSSProperties = { ...input, boxSizing: "border-box" };
const dateField: CSSProperties = { ...input, padding: "7px 10px", boxSizing: "border-box" };
const rowField: CSSProperties = { ...smallInput, padding: "6px 8px", boxSizing: "border-box" };

const rowAction: CSSProperties = {
  flex: "none",
  border: "none",
  cursor: "pointer",
  background: "none",
  color: "var(--label-2)",
  fontSize: 12,
  fontWeight: 600,
  padding: "0 4px",
  whiteSpace: "nowrap",
};

/** Two-step delete props from a useConfirmDelete instance. */
type Armed = {
  label: string;
  color: string;
  fontWeight: number;
  title: string;
  onClick: (e?: React.MouseEvent) => void;
};

function DeleteButton({ del, disabled }: { del: Armed; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="hq-hover-accent"
      onClick={del.onClick}
      title={disabled ? "HQ needs at least one hackathon" : del.title}
      disabled={disabled}
      style={{
        flex: "none",
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        background: "none",
        color: disabled ? "var(--faded)" : del.color,
        fontSize: 12,
        fontWeight: del.fontWeight,
        lineHeight: 1,
        padding: 2,
        whiteSpace: "nowrap",
      }}
    >
      {del.label}
    </button>
  );
}

/* ── Hackathons ───────────────────────────────────────────────────── */

function HackathonRow({
  hackathon,
  current,
  del,
  onlyOne,
}: {
  hackathon: Hackathon;
  current: boolean;
  del: Armed;
  onlyOne: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLInputElement>(null);

  const save = () => {
    const name = (nameRef.current?.value ?? hackathon.name).trim();
    const startDate = startRef.current?.value || hackathon.startDate;
    const endDate = endRef.current?.value || hackathon.endDate;
    if (!name) return;
    if (
      name === hackathon.name &&
      startDate === hackathon.startDate &&
      endDate === hackathon.endDate
    ) {
      return;
    }
    startTransition(async () => {
      const res = await updateHackathon(hackathon.id, { name, startDate, endDate });
      if (!res.ok) showToast(res.error ?? "Could not save the hackathon");
    });
  };

  const open = () => {
    startTransition(async () => {
      const res = await switchHackathon(hackathon.id);
      if (!res.ok) {
        showToast(res.error ?? "Could not open the hackathon");
        return;
      }
      router.push("/hq");
    });
  };

  const toggleArchived = () => {
    startTransition(async () => {
      const res = hackathon.archived
        ? await unarchiveHackathon(hackathon.id)
        : await archiveHackathon(hackathon.id);
      if (!res.ok) showToast(res.error ?? "Could not update the hackathon");
      else showToast(`${hackathon.archived ? "Unarchived" : "Archived"} ${hackathon.name}`);
    });
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        flexWrap: "wrap",
        padding: "8px 0",
        borderBottom: "1px solid var(--sep)",
        opacity: hackathon.archived ? 0.62 : 1,
      }}
    >
      <span
        title="Internal HQ hackathon ID"
        style={{
          flex: "none",
          width: 44,
          fontSize: 12,
          fontWeight: 600,
          color: "var(--label-3)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        #{hackathon.id}
      </span>
      <input
        ref={nameRef}
        defaultValue={hackathon.name}
        onBlur={save}
        placeholder="Hackathon name"
        aria-label="Hackathon name"
        style={{ ...rowField, flex: 1, minWidth: 180, fontWeight: 600 }}
      />
      <input
        ref={startRef}
        type="date"
        defaultValue={hackathon.startDate}
        onChange={save}
        aria-label="Start date"
        style={{ ...rowField, width: 150, flex: "none" }}
      />
      <input
        ref={endRef}
        type="date"
        defaultValue={hackathon.endDate}
        onChange={save}
        aria-label="End date"
        style={{ ...rowField, width: 150, flex: "none" }}
      />
      {hackathon.archived ? (
        <span
          style={{
            flex: "none",
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--label-3)",
            padding: "0 4px",
          }}
        >
          Archived
        </span>
      ) : null}
      {current ? (
        <span
          style={{
            flex: "none",
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--accent)",
            padding: "0 4px",
          }}
        >
          Current
        </span>
      ) : (
        <button type="button" className="hq-hover-accent" onClick={open} style={rowAction}>
          Open
        </button>
      )}
      <button
        type="button"
        className="hq-hover-accent"
        onClick={toggleArchived}
        title={
          hackathon.archived
            ? "Bring this edition back among the open ones"
            : "Put this edition away. Nothing is deleted, and it can still be opened."
        }
        style={rowAction}
      >
        {hackathon.archived ? "Unarchive" : "Archive"}
      </button>
      <DeleteButton del={del} disabled={onlyOne} />
    </div>
  );
}

export function HackathonsCard({
  hackathons,
  currentId,
}: {
  hackathons: Hackathon[];
  currentId: number;
}) {
  const [, startTransition] = useTransition();
  const armed = useConfirmDelete();
  const nextId = hackathons.reduce((max, h) => Math.max(max, h.id), 0) + 1;
  const [draftId, setDraftId] = useState(String(nextId));
  const [draftName, setDraftName] = useState("");
  const [draftStart, setDraftStart] = useState("");
  const [draftEnd, setDraftEnd] = useState("");
  const [error, setError] = useState("");

  const add = () => {
    const name = draftName.trim();
    const idValue = Number(draftId);
    if (!Number.isInteger(idValue) || idValue < 1) {
      setError("The hackathon id must be a whole number.");
      return;
    }
    if (!name || !draftStart || !draftEnd) {
      setError("Name, start date and end date are required.");
      return;
    }
    setError("");
    startTransition(async () => {
      const res = await createHackathon({
        id: idValue,
        name,
        startDate: draftStart,
        endDate: draftEnd,
      });
      if (!res.ok) {
        setError(res.error ?? "Could not add the hackathon.");
        return;
      }
      setDraftId(String(Math.max(idValue, nextId) + 1));
      setDraftName("");
      setDraftStart("");
      setDraftEnd("");
      showToast(`Added ${name}`);
    });
  };

  const remove = (h: Hackathon) => {
    startTransition(async () => {
      const res = await deleteHackathon(h.id);
      if (!res.ok) showToast(res.error ?? "Could not delete the hackathon");
      else showToast(`Deleted ${h.name}`);
    });
  };

  return (
    <div style={{ ...card, marginTop: 16 }} id="hackathons">
      <div style={cardTitle}>Hackathons</div>
      <div style={{ fontSize: 13, color: "var(--label-2)", marginTop: 2 }}>
        Each hackathon is its own CRM. A new one starts with this edition&apos;s targets and
        submission gates, and nothing else. An edition stays open until you archive it -
        its end date passing changes nothing, so demo day can follow the hackathon.
        Deleting one removes everything filed under it.
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
        {hackathons.map((h) => (
          <HackathonRow
            key={h.id}
            hackathon={h}
            current={h.id === currentId}
            onlyOne={hackathons.length <= 1}
            del={armed(`hk-${h.id}`, "×", () => remove(h))}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginTop: 14,
        }}
      >
        <FormField
          label="ID"
          hint="An unused internal HQ ID. Configure the Colosseum ID separately in builder onboarding settings."
          width={90}
        >
          <input
            type="number"
            min={1}
            step={1}
            value={draftId}
            onChange={(e) => setDraftId(e.target.value)}
            aria-label="New hackathon id"
            style={field}
          />
        </FormField>
        <FormField label="New hackathon" flex={1} minWidth={200}>
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Name"
            aria-label="New hackathon name"
            style={field}
          />
        </FormField>
        <FormField label="Starts" minWidth={150}>
          <input
            type="date"
            value={draftStart}
            onChange={(e) => setDraftStart(e.target.value)}
            style={dateField}
          />
        </FormField>
        <FormField label="Ends" minWidth={150}>
          <input
            type="date"
            value={draftEnd}
            onChange={(e) => setDraftEnd(e.target.value)}
            style={dateField}
          />
        </FormField>
        <button type="button" onClick={add} style={{ ...primaryBtn, padding: "9px 16px" }}>
          Add
        </button>
      </div>
      {draftStart && draftEnd ? (
        <div style={{ fontSize: 12, color: "var(--label-3)", marginTop: 8 }}>
          {fmtDateRange(draftStart, draftEnd)}
        </div>
      ) : null}
      {error ? <div style={{ fontSize: 12, color: "var(--red)", marginTop: 8 }}>{error}</div> : null}
    </div>
  );
}

/* ── Submission gates ─────────────────────────────────────────────── */

type GateAction = { type: "add"; gate: Gate } | { type: "remove"; id: string };

function gateReducer(state: Gate[], a: GateAction): Gate[] {
  return a.type === "add" ? [...state, a.gate] : state.filter((g) => g.id !== a.id);
}

function GateRow({ gate, del }: { gate: Gate; del: Armed }) {
  const [, startTransition] = useTransition();
  const ref = useRef<HTMLInputElement>(null);

  const save = () => {
    const label = (ref.current?.value ?? gate.label).trim();
    if (!label || label === gate.label) return;
    startTransition(async () => {
      const res = await renameGate(gate.id, label);
      if (!res.ok) {
        showToast(res.error ?? "Could not rename the gate");
        if (ref.current) ref.current.value = gate.label;
      }
    });
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        padding: "8px 0",
        borderBottom: "1px solid var(--sep)",
      }}
    >
      <input
        ref={ref}
        defaultValue={gate.label}
        onBlur={save}
        placeholder="Gate"
        aria-label="Gate label"
        style={{ ...rowField, flex: 1, minWidth: 160 }}
      />
      <DeleteButton del={del} />
    </div>
  );
}

export function GatesCard({ gates }: { gates: Gate[] }) {
  const [, startTransition] = useTransition();
  const [rows, applyOptimistic] = useOptimistic(gates, gateReducer);
  const armed = useConfirmDelete();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  const add = () => {
    const label = draft.trim();
    if (!label) return;
    setError("");
    startTransition(async () => {
      applyOptimistic({ type: "add", gate: { id: `tmp-${Date.now()}`, label } });
      const res = await addGate(label);
      if (!res.ok) setError(res.error ?? "Could not add the gate.");
    });
    setDraft("");
  };

  const remove = (id: string) => {
    startTransition(async () => {
      applyOptimistic({ type: "remove", id });
      await deleteGate(id);
    });
  };

  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={cardTitle}>Submission gates</div>
      <div style={{ fontSize: 13, color: "var(--label-2)", marginTop: 2 }}>
        The checklist every project works through; a project that has ticked all of them
        counts as a verified submission. Removing a gate also clears it on every project.
      </div>
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginTop: 10,
        }}
      >
        <FormField label="Gate" flex={1} minWidth={220}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            style={field}
          />
        </FormField>
        <button type="button" onClick={add} style={{ ...primaryBtn, padding: "9px 16px" }}>
          Add
        </button>
      </div>
      {error ? <div style={{ fontSize: 12, color: "var(--red)", marginTop: 8 }}>{error}</div> : null}
      <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
        {rows.map((g) => (
          <GateRow key={g.id} gate={g} del={armed(`gate-${g.id}`, "×", () => remove(g.id))} />
        ))}
        {rows.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--label-3)", padding: "10px 0" }}>
            No gates yet. Without any, every project counts as verified.
          </div>
        )}
      </div>
    </div>
  );
}
