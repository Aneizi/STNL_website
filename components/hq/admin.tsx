"use client";

import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import {
  FormField,
  card,
  cardTitle,
  input,
  pageTitle,
  primaryBtn,
  smallInput,
} from "@/components/hq/ui";
import {
  addMilestone,
  deleteMilestone,
  updateMilestone,
  updateSettings,
  type SettingsPatch,
} from "@/lib/hq/actions/admin";
import type { Milestone, Settings } from "@/lib/hq/types";

const field: CSSProperties = { ...input, boxSizing: "border-box" };
const dateField: CSSProperties = { ...input, padding: "7px 10px", boxSizing: "border-box" };

type NumberKey =
  | "prospects_reached"
  | "prospects_target"
  | "committed_manual"
  | "committed_target"
  | "committed_glide"
  | "active_at_kickoff"
  | "active_target"
  | "verified_target";

const NUMBER_FIELDS: Array<{
  key: NumberKey;
  label: string;
  read: (s: Settings) => number;
}> = [
  { key: "prospects_reached", label: "Prospects reached", read: (s) => s.prospectsReached },
  { key: "prospects_target", label: "Prospects target", read: (s) => s.prospectsTarget },
  { key: "committed_manual", label: "Committed (manual count)", read: (s) => s.committedManual },
  { key: "committed_target", label: "Committed target", read: (s) => s.committedTarget },
  { key: "committed_glide", label: "Glide path by kickoff", read: (s) => s.committedGlide },
  { key: "active_at_kickoff", label: "Active at kickoff", read: (s) => s.activeAtKickoff },
  { key: "active_target", label: "Active target", read: (s) => s.activeTarget },
  { key: "verified_target", label: "Verified target", read: (s) => s.verifiedTarget },
];

function readNumber(fd: FormData, key: string): number | undefined {
  const raw = String(fd.get(key) ?? "").trim();
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function buildNumbersPatch(fd: FormData, settings: Settings): SettingsPatch {
  const patch: SettingsPatch = {};
  for (const f of NUMBER_FIELDS) {
    const v = readNumber(fd, f.key);
    if (v !== undefined && v !== f.read(settings)) patch[f.key] = v;
  }
  return patch;
}

function buildSetupPatch(fd: FormData, settings: Settings): SettingsPatch {
  const patch: SettingsPatch = {};
  const staleDays = readNumber(fd, "stale_days");
  if (staleDays !== undefined && staleDays !== settings.staleDays) patch.stale_days = staleDays;
  const finalistCap = readNumber(fd, "finalist_cap");
  if (finalistCap !== undefined && finalistCap !== settings.finalistCap)
    patch.finalist_cap = finalistCap;
  const verified = fd.get("verified_only_finalists") != null;
  if (verified !== settings.verifiedOnlyFinalists) patch.verified_only_finalists = verified;
  const calStart = String(fd.get("cal_start") ?? "").trim();
  if (calStart && calStart !== settings.calStart) patch.cal_start = calStart;
  const calEnd = String(fd.get("cal_end") ?? "").trim();
  if (calEnd && calEnd !== settings.calEnd) patch.cal_end = calEnd;
  const prospectsSub = String(fd.get("prospects_sub") ?? "");
  if (prospectsSub !== settings.prospectsSub) patch.prospects_sub = prospectsSub;
  const activeSub = String(fd.get("active_sub") ?? "");
  if (activeSub !== settings.activeSub) patch.active_sub = activeSub;
  return patch;
}

function useSavedFlash() {
  const [phase, setPhase] = useState<"hidden" | "shown" | "fading">("hidden");
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => {
    const list = timers.current;
    return () => list.forEach(clearTimeout);
  }, []);
  const flash = () => {
    timers.current.forEach(clearTimeout);
    setPhase("shown");
    timers.current = [
      setTimeout(() => setPhase("fading"), 1400),
      setTimeout(() => setPhase("hidden"), 2000),
    ];
  };
  return { phase, flash };
}

function SettingsCard({
  title,
  mt,
  buildPatch,
  children,
}: {
  title: string;
  mt: number;
  buildPatch: (fd: FormData) => SettingsPatch;
  children: ReactNode;
}) {
  const [, startTransition] = useTransition();
  const { phase, flash } = useSavedFlash();
  const [error, setError] = useState("");

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const patch = buildPatch(new FormData(e.currentTarget));
    setError("");
    if (Object.keys(patch).length === 0) {
      flash();
      return;
    }
    startTransition(async () => {
      const res = await updateSettings(patch);
      if (res.ok) flash();
      else setError(res.error ?? "Could not save.");
    });
  };

  return (
    <div style={{ ...card, marginTop: mt }}>
      <div style={cardTitle}>{title}</div>
      <form onSubmit={onSubmit}>
        {children}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
          <button type="submit" style={primaryBtn}>
            Save
          </button>
          {phase !== "hidden" && (
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--green)",
                opacity: phase === "fading" ? 0 : 1,
                transition: "opacity 600ms ease",
              }}
            >
              Saved
            </span>
          )}
          {error && <span style={{ fontSize: 13, color: "var(--red)" }}>{error}</span>}
        </div>
      </form>
    </div>
  );
}

type MilestoneAction = { type: "add"; m: Milestone } | { type: "remove"; id: string };

function milestoneReducer(state: Milestone[], a: MilestoneAction): Milestone[] {
  return a.type === "add" ? [...state, a.m] : state.filter((m) => m.id !== a.id);
}

function MilestoneRow({
  milestone,
  onRemove,
}: {
  milestone: Milestone;
  onRemove: () => void;
}) {
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
        ref={dateRef}
        type="date"
        defaultValue={milestone.date}
        onChange={save}
        style={{
          ...smallInput,
          padding: "6px 8px",
          width: 150,
          flex: "none",
          boxSizing: "border-box",
        }}
      />
      <input
        ref={labelRef}
        defaultValue={milestone.label}
        onBlur={save}
        placeholder="Milestone"
        style={{
          ...smallInput,
          padding: "6px 8px",
          flex: 1,
          minWidth: 160,
          boxSizing: "border-box",
        }}
      />
      <button
        onClick={onRemove}
        title="Remove milestone"
        style={{
          border: "none",
          cursor: "pointer",
          background: "none",
          color: "var(--label-3)",
          fontSize: 16,
          lineHeight: 1,
          padding: 2,
        }}
      >
        &#215;
      </button>
    </div>
  );
}

function MilestonesCard({ milestones }: { milestones: Milestone[] }) {
  const [, startTransition] = useTransition();
  const [rows, applyOptimistic] = useOptimistic(milestones, milestoneReducer);
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
    <div style={{ ...card, marginTop: 12 }}>
      <div style={cardTitle}>Milestones</div>
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginTop: 10,
        }}
      >
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
        <button onClick={add} style={{ ...primaryBtn, padding: "9px 16px" }}>
          Add
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
        {rows.map((m) => (
          <MilestoneRow key={m.id} milestone={m} onRemove={() => remove(m.id)} />
        ))}
        {rows.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--label-3)", padding: "10px 0" }}>
            No milestones yet.
          </div>
        )}
      </div>
    </div>
  );
}

export function Admin({
  settings,
  milestones,
}: {
  settings: Settings;
  milestones: Milestone[];
}) {
  return (
    <div>
      <h1 style={pageTitle}>Admin</h1>
      <SettingsCard
        title="Campaign numbers"
        mt={16}
        buildPatch={(fd) => buildNumbersPatch(fd, settings)}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))",
            gap: 12,
            marginTop: 12,
          }}
        >
          {NUMBER_FIELDS.map((f) => (
            <FormField key={f.key} label={f.label}>
              <input
                name={f.key}
                type="number"
                min={0}
                defaultValue={f.read(settings)}
                style={field}
              />
            </FormField>
          ))}
        </div>
      </SettingsCard>
      <SettingsCard
        title="Campaign setup"
        mt={12}
        buildPatch={(fd) => buildSetupPatch(fd, settings)}
      >
        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            alignItems: "flex-end",
            marginTop: 12,
          }}
        >
          <FormField
            label="Stale after (days)"
            hint="Days without a check-in before a project counts as stale — highlighted on Projects and listed on the Dashboard."
            width={110}
          >
            <input
              name="stale_days"
              type="number"
              min={1}
              defaultValue={settings.staleDays}
              style={field}
            />
          </FormField>
          <FormField
            label="Finalist cap"
            hint="Most finalists Demo day will accept. Adding beyond this is refused, not just shown in the count."
            width={110}
          >
            <input
              name="finalist_cap"
              type="number"
              min={1}
              defaultValue={settings.finalistCap}
              style={field}
            />
          </FormField>
          <FormField
            label="Verified-only finalists"
            hint="When on, only projects that have passed every submission gate can be added as finalists."
            minWidth={150}
          >
            <div style={{ display: "flex", alignItems: "center", height: 35 }}>
              <input
                name="verified_only_finalists"
                type="checkbox"
                defaultChecked={settings.verifiedOnlyFinalists}
                style={{ accentColor: "var(--accent)", width: 15, height: 15 }}
              />
            </div>
          </FormField>
          <FormField
            label="Calendar start"
            hint="First month shown in the Events calendar."
            minWidth={130}
          >
            <input
              name="cal_start"
              type="month"
              defaultValue={settings.calStart}
              style={dateField}
            />
          </FormField>
          <FormField
            label="Calendar end"
            hint="Last month shown in the Events calendar."
            minWidth={130}
          >
            <input
              name="cal_end"
              type="month"
              defaultValue={settings.calEnd}
              style={dateField}
            />
          </FormField>
          <FormField
            label="Prospects subtitle"
            hint="Caption printed under the Prospects figure on the Dashboard. Text only — it changes nothing that is counted."
            flex={1}
            minWidth={220}
          >
            <input name="prospects_sub" defaultValue={settings.prospectsSub} style={field} />
          </FormField>
          <FormField
            label="Active subtitle"
            hint="Caption printed under the Active figure on the Dashboard. Text only — it changes nothing that is counted."
            flex={1}
            minWidth={220}
          >
            <input name="active_sub" defaultValue={settings.activeSub} style={field} />
          </FormField>
        </div>
      </SettingsCard>
      <MilestonesCard milestones={milestones} />
    </div>
  );
}
