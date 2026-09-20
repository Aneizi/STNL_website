"use client";

import Link from "next/link";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { FormField, card, input, pageTitle, primaryBtn } from "@/components/hq/ui";
import { createPartner, setPartnerStage } from "@/lib/hq/actions/partners";
import type { ActionResult, Classifiers, Partner, Stage } from "@/lib/hq/types";

type StageMove = { id: string; stageSlug: string };

// Outcome stages get a tinted column so the board reads at a glance:
// agreed is a win (green), rejected is a loss (red). The tints reuse the
// theme fills so they track light/dark palettes.
const STAGE_FILLS: Record<string, string> = {
  agreed: "var(--green-fill)",
  rejected: "var(--red-fill)",
};

const isOutcomeStage = (s: Stage) => s.slug === "agreed" || s.slug === "rejected";

const ADD_FAILED = "The partner could not be added. Try again.";

type Drafts = {
  name: string;
  channelId: string;
  captain: string;
  contact: string;
  target: string;
};

export function PartnersBoard({
  partners,
  classifiers,
}: {
  partners: Partner[];
  classifiers: Classifiers;
}) {
  const [, startTransition] = useTransition();
  // Its own transition, so a stage move in flight never dims the Add button.
  const [adding, startAdd] = useTransition();
  const [board, moveCard] = useOptimistic(partners, (state: Partner[], move: StageMove) =>
    state.map((p) => (p.id === move.id ? { ...p, stageSlug: move.stageSlug } : p)),
  );
  const [newPartnerOpen, setNewPartnerOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const [justDropped, setJustDropped] = useState<string | null>(null);
  const dropTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drafts = useRef<Drafts>({ name: "", channelId: "", captain: "", contact: "", target: "" });
  // Agreed and rejected share the board's last cell, stacked win-over-loss.
  const outcomeStages = classifiers.stages.filter(isOutcomeStage);

  useEffect(
    () => () => {
      if (dropTimer.current) clearTimeout(dropTimer.current);
    },
    [],
  );

  // Every toggle starts from blank drafts, opening and closing alike.
  const toggleNewPartner = () => {
    drafts.current = {
      name: "",
      channelId: classifiers.channels[0]?.id ?? "",
      captain: "",
      contact: "",
      target: "",
    };
    setAddError(null);
    setNewPartnerOpen(!newPartnerOpen);
  };

  // The form stays open, drafts intact, until the server has the partner;
  // a refusal shows beside the fields instead of losing what was typed.
  const submitNewPartner = () => {
    const d = drafts.current;
    if (!d.name) return;
    const parsed = Number(d.target || 10);
    startAdd(async () => {
      let result: ActionResult;
      try {
        result = await createPartner({
          name: d.name,
          channelId: d.channelId,
          captainName: d.captain,
          captainContact: d.contact,
          target: Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 10,
        });
      } catch {
        result = { ok: false };
      }
      if (!result.ok) {
        setAddError(result.error ?? ADD_FAILED);
        return;
      }
      setAddError(null);
      setNewPartnerOpen(false);
    });
  };

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
          Partners <span style={{ fontWeight: 400, color: "var(--faded)" }}>{board.length}</span>
        </h1>
        <button type="button" onClick={toggleNewPartner} style={primaryBtn}>
          New partner
        </button>
      </div>
      {newPartnerOpen ? (
        <div
          className="hq-fade-in"
          style={{
            ...card,
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            alignItems: "flex-end",
          }}
        >
          <FormField label="Partner name" flex={1} minWidth={150}>
            <input
              onChange={(e) => {
                drafts.current.name = e.target.value;
              }}
              style={input}
            />
          </FormField>
          <FormField label="Channel" minWidth={180}>
            <select
              defaultValue={classifiers.channels[0]?.id ?? ""}
              onChange={(e) => {
                drafts.current.channelId = e.target.value;
              }}
              style={input}
            >
              {classifiers.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Contact person" flex={1} minWidth={140}>
            <input
              onChange={(e) => {
                drafts.current.captain = e.target.value;
              }}
              style={input}
            />
          </FormField>
          <FormField label="Contact details" flex={1} minWidth={140}>
            <input
              placeholder="tg, x, or email"
              onChange={(e) => {
                drafts.current.contact = e.target.value;
              }}
              style={input}
            />
          </FormField>
          <FormField label="Target" width={90}>
            <input
              type="number"
              min={0}
              onChange={(e) => {
                drafts.current.target = e.target.value;
              }}
              style={{ ...input, width: "100%" }}
            />
          </FormField>
          <button
            type="button"
            onClick={submitNewPartner}
            disabled={adding}
            style={{ ...primaryBtn, padding: "9px 16px", opacity: adding ? 0.5 : 1 }}
          >
            Add
          </button>
          {addError ? (
            <p role="alert" style={{ width: "100%", margin: 0, fontSize: 14, color: "var(--red)" }}>
              {addError}
            </p>
          ) : null}
        </div>
      ) : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(288px,1fr))",
          gap: 12,
          marginTop: 16,
          alignItems: "stretch",
        }}
      >
        {classifiers.stages.filter((s) => !isOutcomeStage(s)).map((stage) => renderStage(stage))}
        {outcomeStages.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* flex-basis 0 splits the cell evenly, so an empty Rejected
                mirrors Agreed instead of collapsing to its header. */}
            {outcomeStages.map((stage) => renderStage(stage, { flex: "1 1 0" }))}
          </div>
        ) : null}
      </div>
    </div>
  );

  function renderStage(stage: Stage, extraStyle?: React.CSSProperties) {
    const cards = board.filter((p) => p.stageSlug === stage.slug);
    return (
      <div
        key={stage.id}
        onDragOver={(e) => {
          e.preventDefault();
          if (dragOverStage !== stage.slug) setDragOverStage(stage.slug);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const pid = e.dataTransfer.getData("text/plain");
          setDragOverStage(null);
          const target = board.find((p) => p.id === pid);
          if (!target || target.stageSlug === stage.slug) return;
          startTransition(async () => {
            moveCard({ id: pid, stageSlug: stage.slug });
            await setPartnerStage(pid, stage.slug);
          });
          setJustDropped(pid);
          if (dropTimer.current) clearTimeout(dropTimer.current);
          dropTimer.current = setTimeout(() => setJustDropped(null), 3000);
        }}
        style={{
          border: "1px solid var(--sep)",
          padding: 10,
          display: "flex",
          flexDirection: "column",
          background:
            dragOverStage === stage.slug
              ? "var(--accent-fill)"
              : (STAGE_FILLS[stage.slug] ?? "transparent"),
          transition: "background 120ms",
          ...extraStyle,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            padding: "2px 4px 10px",
            marginBottom: 10,
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {stage.label}
          </span>
          <span
            style={{
              fontSize: 14,
              color: "var(--label-3)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {cards.length}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
          {/* A real link, as in the design: middle-click, focus ring and the
              address bar all work. Nothing is prefetched, since a board of
              cards would otherwise fetch every detail page on scroll. */}
          {cards.map((p) => (
            <Link
              key={p.id}
              href={`/hq/partners/${p.id}`}
              prefetch={false}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", p.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              className={`hq-card-link hq-card-hover hq-drop-flash${
                justDropped === p.id ? " hq-just-dropped" : ""
              }`}
              style={
                {
                  display: "block",
                  background: "var(--card)",
                  borderRadius: 0,
                  boxShadow: "var(--shadow-1)",
                  padding: "12px 14px",
                  cursor: "grab",
                  color: "inherit",
                  textDecoration: "none",
                  "--hq-drop-color": stage.dropColor,
                } as React.CSSProperties
              }
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 17, fontWeight: 600 }}>{p.name}</span>
                <span
                  style={{
                    fontSize: 14,
                    color: "var(--label-2)",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.attributed}/{p.target}
                </span>
              </div>
              <div style={{ fontSize: 14, color: "var(--label-3)", marginTop: 2 }}>
                {p.channelLabel}
              </div>
              <div style={{ fontSize: 16, color: "var(--label-2)", marginTop: 6 }}>
                {p.captainName}
              </div>
            </Link>
          ))}
        </div>
      </div>
    );
  }
}
