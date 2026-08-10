"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { FormField, card, input, pageTitle, primaryBtn } from "@/components/hq/ui";
import { createPartner, setPartnerStage } from "@/lib/hq/actions/partners";
import type { Classifiers, Partner } from "@/lib/hq/types";

type StageMove = { id: string; stageSlug: string };

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
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [board, moveCard] = useOptimistic(partners, (state: Partner[], move: StageMove) =>
    state.map((p) => (p.id === move.id ? { ...p, stageSlug: move.stageSlug } : p)),
  );
  const [newPartnerOpen, setNewPartnerOpen] = useState(false);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const [justDropped, setJustDropped] = useState<string | null>(null);
  const dropTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drafts = useRef<Drafts>({ name: "", channelId: "", captain: "", contact: "", target: "" });

  useEffect(
    () => () => {
      if (dropTimer.current) clearTimeout(dropTimer.current);
    },
    [],
  );

  const toggleNewPartner = () => {
    if (!newPartnerOpen) {
      drafts.current = {
        name: "",
        channelId: classifiers.channels[0]?.id ?? "",
        captain: "",
        contact: "",
        target: "",
      };
    }
    setNewPartnerOpen(!newPartnerOpen);
  };

  const submitNewPartner = () => {
    const d = drafts.current;
    if (!d.name) return;
    const parsed = Number(d.target || 10);
    startTransition(async () => {
      await createPartner({
        name: d.name,
        channelId: d.channelId,
        captainName: d.captain,
        captainContact: d.contact,
        target: Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 10,
      });
    });
    setNewPartnerOpen(false);
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
        <button onClick={toggleNewPartner} style={primaryBtn}>
          New partner
        </button>
      </div>
      {newPartnerOpen ? (
        <div
          className="hq-fade-in"
          style={{
            ...card,
            marginTop: 14,
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
          <FormField label="Captain" flex={1} minWidth={140}>
            <input
              onChange={(e) => {
                drafts.current.captain = e.target.value;
              }}
              style={input}
            />
          </FormField>
          <FormField label="Captain contact" flex={1} minWidth={140}>
            <input
              placeholder="tg or email"
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
              style={input}
            />
          </FormField>
          <button onClick={submitNewPartner} style={{ ...primaryBtn, padding: "9px 16px" }}>
            Add
          </button>
        </div>
      ) : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))",
          gap: 12,
          marginTop: 16,
          alignItems: "stretch",
        }}
      >
        {classifiers.stages.map((stage) => {
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
                background: dragOverStage === stage.slug ? "var(--accent-fill)" : "transparent",
                transition: "background 120ms",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  padding: "2px 4px 10px",
                  borderBottom: "1px solid var(--sep)",
                  marginBottom: 10,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                  }}
                >
                  {stage.label}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--label-3)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {cards.length}
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                {cards.map((p) => (
                  <div
                    key={p.id}
                    draggable
                    onClick={() => router.push(`/hq/partners/${p.id}`)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", p.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    className={`hq-card-hover hq-drop-flash${
                      justDropped === p.id ? " hq-just-dropped" : ""
                    }`}
                    style={
                      {
                        background: "var(--card)",
                        borderRadius: 0,
                        boxShadow: "var(--shadow-1)",
                        padding: "12px 14px",
                        cursor: "grab",
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
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</span>
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--label-2)",
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.attributed}/{p.target}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--label-3)", marginTop: 2 }}>
                      {p.channelLabel}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--label-2)", marginTop: 6 }}>
                      {p.captainName}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
