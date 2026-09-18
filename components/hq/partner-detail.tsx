"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import {
  Badge,
  accentBtn,
  card,
  cardTitle,
  pageTitle,
  smallInput,
} from "@/components/hq/ui";
import { CopyButton, useConfirmDelete, useSavedFlash } from "@/components/hq/ui-client";
import {
  addPartnerContact,
  deletePartner,
  setPartnerStage,
  togglePartnerExchange,
  updatePartnerDetail,
} from "@/lib/hq/actions/partners";
import { fmtDate, fmtWhen } from "@/lib/hq/format";
import type {
  ActionResult,
  Classifiers,
  PartnerDetail as PartnerDetailData,
} from "@/lib/hq/types";

type Patch =
  | { kind: "stage"; slug: string }
  | { kind: "channel"; id: string }
  | { kind: "name"; value: string }
  | { kind: "captain"; value: string }
  | { kind: "captainContact"; value: string }
  | { kind: "target"; value: number }
  | { kind: "exchange"; itemId: string; done: boolean }
  | { kind: "contact"; body: string; author: string; createdAt: string };

function applyPatch(cur: PartnerDetailData, p: Patch): PartnerDetailData {
  switch (p.kind) {
    case "stage":
      return { ...cur, stageSlug: p.slug };
    case "channel":
      return { ...cur, channelId: p.id };
    case "name":
      return { ...cur, name: p.value };
    case "captain":
      return { ...cur, captainName: p.value };
    case "captainContact":
      return { ...cur, captainContact: p.value };
    case "target":
      return { ...cur, target: p.value };
    case "exchange":
      return {
        ...cur,
        exchange: p.done
          ? [...cur.exchange, p.itemId]
          : cur.exchange.filter((i) => i !== p.itemId),
      };
    case "contact":
      return {
        ...cur,
        contacts: [
          {
            id: `optimistic-${cur.contacts.length}`,
            author: p.author,
            body: p.body,
            createdAt: p.createdAt,
          },
          ...cur.contacts,
        ],
      };
  }
}

// Header badge tones per stage; label-3 falls back to a plain fill.
const STAGE_TONES: Record<string, string> = {
  agreed: "green",
  rejected: "red",
  call: "accent",
  sent: "orange",
  draft: "label-3",
};

const SAVE_FAILED = "The change could not be saved. Try again.";
const DELETE_FAILED = "The partner could not be deleted. Try again.";
const LOG_FAILED = "The interaction could not be logged. Try again.";

/** The three cards sit in a grid of their own, so none carries the atom's top margin. */
const panel: React.CSSProperties = { ...card, marginTop: 0 };

/** One labelled row in the header's details grid. */
const detailRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "84px minmax(0,1fr)",
  columnGap: 10,
  alignItems: "center",
};

const detailLabel: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--label-3)",
};

const detailValue: React.CSSProperties = { fontSize: 17, padding: "6px 0" };

/** Edit-mode inputs sit on the page, so they get the card background. */
const detailField: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  minHeight: 44,
  padding: "6px 8px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "var(--card)",
  color: "var(--label-1)",
  fontSize: 16,
};

const alertLine: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
  color: "var(--red)",
};

export function PartnerDetail({
  partner,
  classifiers,
  timezone,
  userName,
}: {
  partner: PartnerDetailData;
  classifiers: Classifiers;
  timezone: string;
  userName: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [view, patch] = useOptimistic(partner, applyPatch);
  // One Edit toggle for the whole header; every control saves on change or
  // blur, confirmed only by the Saved flash beside the name.
  const [editing, setEditing] = useState(false);
  const { phase: savedPhase, flash } = useSavedFlash();
  const armed = useConfirmDelete();
  const [contactDraft, setContactDraft] = useState("");
  const [deleting, setDeleting] = useState(false);
  // Refusals surface beside the name; the contact log keeps its own line so
  // the message sits next to the draft it kept.
  const [error, setError] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  const attempt = async (act: () => Promise<ActionResult>): Promise<ActionResult> => {
    try {
      return await act();
    } catch {
      return { ok: false };
    }
  };

  const onDelete = () => {
    setDeleting(true);
    startTransition(async () => {
      const result = await attempt(() => deletePartner(partner.id));
      if (result.ok) {
        router.push("/hq/partners");
        return;
      }
      setError(result.error ?? DELETE_FAILED);
      setDeleting(false);
    });
  };

  // Optimistic first, then the server; the Saved flash waits for its answer,
  // and a refusal leaves the typed value in the field.
  const save = (p: Patch, act: () => Promise<ActionResult>, withFlash = true) =>
    startTransition(async () => {
      patch(p);
      const result = await attempt(act);
      if (!result.ok) {
        setError(result.error ?? SAVE_FAILED);
        return;
      }
      setError(null);
      if (withFlash) flash();
    });

  const onName = (raw: string) => {
    const value = raw.trim();
    if (!value || value === partner.name) return;
    save({ kind: "name", value }, () =>
      updatePartnerDetail(partner.id, { field: "name", value }),
    );
  };
  const onCaptain = (value: string) => {
    if (value === partner.captainName) return;
    save({ kind: "captain", value }, () =>
      updatePartnerDetail(partner.id, { field: "captainName", value }),
    );
  };
  const onCaptainContact = (value: string) => {
    if (value === partner.captainContact) return;
    save({ kind: "captainContact", value }, () =>
      updatePartnerDetail(partner.id, { field: "captainContact", value }),
    );
  };
  const onTarget = (raw: string) => {
    const value = Math.max(0, Math.trunc(Number(raw) || 0));
    if (value === partner.target) return;
    save({ kind: "target", value }, () =>
      updatePartnerDetail(partner.id, { field: "target", value }),
    );
  };
  const onChannel = (id: string) => {
    save({ kind: "channel", id }, () =>
      updatePartnerDetail(partner.id, { field: "channelId", value: id }),
    );
  };
  const onStage = (slug: string) => {
    save({ kind: "stage", slug }, () => setPartnerStage(partner.id, slug));
  };
  const onExchange = (itemId: string, done: boolean) => {
    save({ kind: "exchange", itemId, done }, () => togglePartnerExchange(partner.id, itemId, done), false);
  };
  const onAddContact = () => {
    const body = contactDraft.trim();
    if (!body) return;
    setContactDraft("");
    startTransition(async () => {
      patch({ kind: "contact", body, author: userName, createdAt: new Date().toISOString() });
      const result = await attempt(() => addPartnerContact(partner.id, body));
      if (result.ok) {
        setLogError(null);
        return;
      }
      setLogError(result.error ?? LOG_FAILED);
      setContactDraft((draft) => draft || body);
    });
  };

  const pct =
    view.target > 0
      ? Math.min(100, (view.attributed / view.target) * 100)
      : view.attributed > 0
        ? 100
        : 0;
  const statusBySlug = new Map(classifiers.statuses.map((s) => [s.slug, s]));
  const stage = classifiers.stages.find((s) => s.slug === view.stageSlug);
  const channelLabel =
    classifiers.channels.find((c) => c.id === view.channelId)?.label ?? "";
  const tone = STAGE_TONES[view.stageSlug] ?? "label-3";
  const del = armed(`partner-${partner.id}`, "Delete", onDelete);

  return (
    <div>
      <Link href="/hq/partners" style={{ color: "var(--accent)", fontSize: 17, padding: 0 }}>
        &#8249; All partners
      </Link>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginTop: 8,
        }}
      >
        {editing ? (
          <input
            defaultValue={view.name}
            onBlur={(e) => onName(e.target.value)}
            aria-label="Partner name"
            style={{
              flex: "none",
              width: 340,
              maxWidth: "100%",
              boxSizing: "border-box",
              fontFamily: "var(--serif)",
              fontSize: 44,
              fontWeight: 400,
              letterSpacing: "-0.01em",
              padding: "2px 8px",
              marginLeft: -9,
              border: "1px solid var(--sep)",
              borderRadius: 0,
              background: "var(--card)",
              color: "var(--label-1)",
            }}
          />
        ) : (
          <h1
            style={{
              ...pageTitle,
              flex: "none",
              minWidth: 0,
              maxWidth: "100%",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {view.name}
          </h1>
        )}
        <span
          style={{
            flex: "none",
            fontSize: 13,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            padding: "4px 9px",
            borderRadius: 2,
            color: `var(--${tone})`,
            background: tone === "label-3" ? "var(--fill-3)" : `var(--${tone}-fill)`,
          }}
        >
          {stage?.label ?? ""}
        </span>
        {savedPhase !== "hidden" && (
          <span
            style={{
              flex: "none",
              fontSize: 14,
              fontWeight: 600,
              color: "var(--green)",
              opacity: savedPhase === "fading" ? 0 : 1,
              transition: "opacity 600ms ease",
            }}
          >
            Saved
          </span>
        )}
        {error ? (
          <p role="alert" style={{ ...alertLine, flex: "none" }}>
            {error}
          </p>
        ) : null}
        <button
          type="button"
          className="hq-hover-accent"
          onClick={() => setEditing(!editing)}
          style={{
            flex: "none",
            border: "none",
            cursor: "pointer",
            background: "none",
            color: editing ? "var(--accent)" : "var(--label-3)",
            fontSize: 14,
            fontWeight: 600,
            padding: 2,
            marginLeft: "auto",
          }}
        >
          {editing ? "Done" : "Edit"}
        </button>
        <button
          type="button"
          className="hq-hover-accent"
          onClick={del.onClick}
          disabled={deleting}
          title={del.title}
          style={{
            flex: "none",
            border: "none",
            cursor: "pointer",
            background: "none",
            color: del.color,
            fontSize: 14,
            fontWeight: del.fontWeight,
            padding: 2,
            whiteSpace: "nowrap",
          }}
        >
          {deleting ? "Deleting…" : del.label}
        </button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(288px,1fr))",
          columnGap: 20,
          rowGap: 8,
          marginTop: 14,
          maxWidth: 820,
        }}
      >
        <div style={detailRow}>
          <span style={detailLabel}>Channel</span>
          {editing ? (
            <select
              value={view.channelId}
              onChange={(e) => onChannel(e.target.value)}
              style={detailField}
            >
              {classifiers.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <span style={detailValue}>{channelLabel}</span>
          )}
        </div>
        <div style={detailRow}>
          <span style={detailLabel}>Stage</span>
          {editing ? (
            <select
              value={view.stageSlug}
              onChange={(e) => onStage(e.target.value)}
              style={detailField}
            >
              {classifiers.stages.map((s) => (
                <option key={s.id} value={s.slug}>
                  {s.label}
                </option>
              ))}
            </select>
          ) : (
            <span style={detailValue}>{stage?.label ?? ""}</span>
          )}
        </div>
        <div style={detailRow}>
          <span style={detailLabel}>Captain</span>
          {editing ? (
            <input
              defaultValue={partner.captainName}
              onBlur={(e) => onCaptain(e.target.value)}
              style={detailField}
            />
          ) : (
            <span style={detailValue}>{view.captainName}</span>
          )}
        </div>
        <div style={detailRow}>
          <span style={detailLabel}>Contact</span>
          {/* flex 0 1 auto in view mode: the text shrinks to its content, so
              the copy icon sits beside the address, not at the cell's edge. */}
          <div style={{ display: "flex", gap: 6, minWidth: 0, alignItems: "center" }}>
            {editing ? (
              <input
                defaultValue={partner.captainContact}
                onBlur={(e) => onCaptainContact(e.target.value)}
                aria-label="Captain contact"
                style={{
                  ...detailField,
                  flex: 1,
                  minWidth: 0,
                  fontFamily: "var(--mono)",
                  fontSize: 14,
                }}
              />
            ) : (
              <span
                style={{
                  flex: "0 1 auto",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  padding: "6px 0",
                  color: "var(--label-2)",
                  fontFamily: "var(--mono)",
                  fontSize: 14,
                }}
              >
                {view.captainContact}
              </span>
            )}
            <CopyButton value={view.captainContact} />
          </div>
        </div>
        <div style={detailRow}>
          <span style={detailLabel}>Target</span>
          {editing ? (
            <input
              type="number"
              min={0}
              defaultValue={partner.target}
              onBlur={(e) => onTarget(e.target.value)}
              style={{ ...detailField, width: 74 }}
            />
          ) : (
            <span style={{ ...detailValue, fontVariantNumeric: "tabular-nums" }}>
              {view.target}
            </span>
          )}
        </div>
      </div>
      <div style={{ fontSize: 14, color: "var(--label-3)", marginTop: 14 }}>
        Last touched by {view.touchedBy}, {fmtDate(view.touchedAt ?? "")}
        {editing ? ". Changes save as you make them." : "."}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(336px,1fr))",
          gap: 12,
          marginTop: 16,
          alignItems: "start",
        }}
      >
        <div style={panel}>
          <div style={cardTitle}>Exchange checklist</div>
          {classifiers.exchangeItems.map((x) => {
            const done = view.exchange.includes(x.id);
            return (
              <label
                key={x.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 0",
                  fontSize: 17,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={done}
                  onChange={() => onExchange(x.id, !done)}
                  style={{ accentColor: "var(--accent)", width: 15, height: 15, margin: 0 }}
                />
                <span style={{ color: done ? "var(--label-3)" : "var(--label-1)" }}>{x.label}</span>
              </label>
            );
          })}
          <div style={{ marginTop: 14 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 16,
                color: "var(--label-2)",
              }}
            >
              <span>Attributed teams vs target</span>
              <span
                style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "var(--label-1)" }}
              >
                {view.attributed} / {view.target}
              </span>
            </div>
            <div
              style={{
                height: 4,
                borderRadius: 0,
                background: "var(--fill-3)",
                marginTop: 8,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  borderRadius: 0,
                  background: "var(--accent)",
                  width: `${pct}%`,
                }}
              />
            </div>
          </div>
        </div>
        <div style={panel}>
          <div style={cardTitle}>Contact log</div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <input
              value={contactDraft}
              onChange={(e) => setContactDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onAddContact();
              }}
              placeholder="Log an interaction"
              style={{ ...smallInput, flex: 1, minWidth: 0 }}
            />
            <button
              type="button"
              onClick={onAddContact}
              style={{ ...accentBtn, background: "var(--fill-3)" }}
            >
              Add
            </button>
          </div>
          {logError ? (
            <p role="alert" style={{ ...alertLine, marginTop: 8 }}>
              {logError}
            </p>
          ) : null}
          {view.contacts.map((n) => (
            <div key={n.id} style={{ padding: "8px 0" }}>
              <div style={{ fontSize: 14, color: "var(--label-3)" }}>
                {fmtWhen(n.createdAt, timezone)}, {n.author}
              </div>
              <div style={{ fontSize: 16, marginTop: 2 }}>{n.body}</div>
            </div>
          ))}
        </div>
        <div style={panel}>
          <div style={cardTitle}>Attributed teams</div>
          {view.teams.map((t) => {
            const status = statusBySlug.get(t.statusSlug);
            return (
              <div
                key={t.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  padding: "8px 0",
                }}
              >
                <span style={{ fontSize: 17 }}>{t.name}</span>
                {status ? (
                  <Badge label={status.label} color={status.color} bg={`${status.color}-fill`} />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
