"use client";

import type { CSSProperties } from "react";
import { useOptimistic, useRef, useState, useTransition } from "react";
import { FormField, card, cardTitle, input, pageTitle, primaryBtn, smallInput } from "@/components/hq/ui";
import { useConfirmDelete } from "@/components/hq/ui-client";
import { addMilestone, deleteMilestone, updateMilestone } from "@/lib/hq/actions/admin";
import type { Gate, Hackathon, Milestone } from "@/lib/hq/types";
import { fmtDateRange } from "@/lib/hq/hackathon-format";
import { DeleteButton, GatesCard, HackathonsCard, type Armed } from "./admin-hackathons";

const field: CSSProperties = { ...input, boxSizing: "border-box" };
const dateField: CSSProperties = { ...input, padding: "7px 10px", boxSizing: "border-box" };
const rowField: CSSProperties = { ...smallInput, padding: "6px 8px", boxSizing: "border-box" };

type MilestoneAction = { type: "add"; m: Milestone } | { type: "remove"; id: string };

function milestoneReducer(state: Milestone[], a: MilestoneAction): Milestone[] {
  return a.type === "add" ? [...state, a.m] : state.filter((m) => m.id !== a.id);
}

function MilestoneRow({ milestone, del }: { milestone: Milestone; del: Armed }) {
  const [, startTransition] = useTransition();
  const dateRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  const save = () => {
    const date = dateRef.current?.value ?? milestone.date;
    const label = (labelRef.current?.value ?? milestone.label).trim();
    if (!date || !label) return;
    if (date === milestone.date && label === milestone.label) return;
    startTransition(async () => {
      await updateMilestone(milestone.id, { date, label });
    });
  };

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0" }}>
      <input
        ref={dateRef}
        type="date"
        defaultValue={milestone.date}
        onChange={save}
        aria-label="Milestone date"
        style={{ ...rowField, width: 150, flex: "none" }}
      />
      <input
        ref={labelRef}
        defaultValue={milestone.label}
        onBlur={save}
        placeholder="Milestone"
        aria-label="Milestone"
        style={{ ...rowField, flex: 1, minWidth: 160 }}
      />
      <DeleteButton del={del} />
    </div>
  );
}

function MilestonesCard({ milestones }: { milestones: Milestone[] }) {
  const [, startTransition] = useTransition();
  const [rows, applyOptimistic] = useOptimistic(milestones, milestoneReducer);
  const armed = useConfirmDelete();
  const [draftDate, setDraftDate] = useState("");
  const [draftLabel, setDraftLabel] = useState("");

  const add = () => {
    const label = draftLabel.trim();
    const date = draftDate;
    if (!date || !label) return;
    startTransition(async () => {
      applyOptimistic({ type: "add", m: { id: `tmp-${Date.now()}`, date, label } });
      await addMilestone({ date, label });
    });
    setDraftDate("");
    setDraftLabel("");
  };

  const remove = (id: string) => {
    startTransition(async () => {
      applyOptimistic({ type: "remove", id });
      await deleteMilestone(id);
    });
  };

  return (
    <div style={card}>
      <div style={cardTitle}>Milestones</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
        <FormField label="Date" minWidth={150}>
          <input
            type="date"
            value={draftDate}
            onChange={(e) => setDraftDate(e.target.value)}
            style={dateField}
          />
        </FormField>
        <FormField label="Milestone" flex={1} minWidth={180}>
          <input
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            style={field}
          />
        </FormField>
        <button type="button" onClick={add} style={{ ...primaryBtn, padding: "9px 16px" }}>
          Add
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
        {rows.map((m) => (
          <MilestoneRow key={m.id} milestone={m} del={armed(`ms-${m.id}`, "×", () => remove(m.id))} />
        ))}
      </div>
    </div>
  );
}

export function Admin({
  current,
  hackathons,
  milestones,
  gates,
}: {
  /** The hackathon whose gates and milestones are shown. */
  current: Hackathon;
  hackathons: Hackathon[];
  milestones: Milestone[];
  gates: Gate[];
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <h1 style={pageTitle}>Admin</h1>
        <span style={{ fontSize: 16, color: "var(--label-3)" }}>
          {current.name}, {fmtDateRange(current.startDate, current.endDate)}
        </span>
      </div>
      <HackathonsCard hackathons={hackathons} currentId={current.id} />
      <GatesCard gates={gates} />
      <MilestonesCard milestones={milestones} />
    </div>
  );
}
