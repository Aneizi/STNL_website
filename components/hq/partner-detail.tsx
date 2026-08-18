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
  smallSelect,
} from "@/components/hq/ui";
import {
  addPartnerContact,
  deletePartner,
  setPartnerStage,
  togglePartnerExchange,
  updatePartnerDetail,
} from "@/lib/hq/actions/partners";
import { fmtDate, fmtWhen } from "@/lib/hq/format";
import type { Classifiers, PartnerDetail as PartnerDetailData } from "@/lib/hq/types";

type Patch =
  | { kind: "stage"; slug: string }
  | { kind: "channel"; id: string }
  | { kind: "name"; value: string }
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
  const [editingName, setEditingName] = useState(false);
  const [contactDraft, setContactDraft] = useState("");
  // Inline two-step delete; a window.confirm would block the whole tab.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const onDelete = () => {
    setDeleting(true);
    startTransition(async () => {
      const result = await deletePartner(partner.id);
      if (result.ok) {
        router.push("/hq/partners");
      } else {
        setDeleting(false);
        setConfirmingDelete(false);
      }
    });
  };

  const mutate = (p: Patch | null, act: () => Promise<unknown>) =>
    startTransition(async () => {
      if (p) patch(p);
      await act();
    });

  const onName = (raw: string) => {
    const value = raw.trim();
    if (!value || value === partner.name) return;
    mutate({ kind: "name", value }, () =>
      updatePartnerDetail(partner.id, { field: "name", value }),
    );
  };
  const onCaptain = (value: string) => {
    if (value === partner.captainName) return;
    mutate(null, () => updatePartnerDetail(partner.id, { field: "captainName", value }));
  };
  const onCaptainContact = (value: string) => {
    if (value === partner.captainContact) return;
    mutate(null, () => updatePartnerDetail(partner.id, { field: "captainContact", value }));
  };
  const onTarget = (raw: string) => {
    const value = Math.max(0, Math.trunc(Number(raw) || 0));
    if (value === partner.target) return;
    mutate({ kind: "target", value }, () =>
      updatePartnerDetail(partner.id, { field: "target", value }),
    );
  };
  const onAddContact = () => {
    const body = contactDraft;
    if (!body) return;
    mutate({ kind: "contact", body, author: userName, createdAt: new Date().toISOString() }, () =>
      addPartnerContact(partner.id, body),
    );
    setContactDraft("");
  };

  const pct =
    view.target > 0
      ? Math.min(100, (view.attributed / view.target) * 100)
      : view.attributed > 0
        ? 100
        : 0;
  const statusBySlug = new Map(classifiers.statuses.map((s) => [s.slug, s]));

  return (
    <div>
      <Link href="/hq/partners" style={{ color: "var(--accent)", fontSize: 14, padding: 0 }}>
        &#8249; All partners
      </Link>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
          marginTop: 10,
        }}
      >
        {!editingName ? (
          <h1 style={pageTitle}>{view.name}</h1>
        ) : (
          <input
            defaultValue={view.name}
            onBlur={(e) => onName(e.target.value)}
            style={{
              fontFamily: "var(--serif)",
              fontSize: 30,
              padding: "2px 8px",
              border: "1px solid var(--sep)",
              borderRadius: 0,
              background: "var(--card)",
              color: "var(--label-1)",
              width: 280,
              maxWidth: "100%",
              boxSizing: "border-box",
            }}
          />
        )}
        <button
          onClick={() => setEditingName(!editingName)}
          style={{
            border: "none",
            cursor: "pointer",
            background: "none",
            color: editingName ? "var(--accent)" : "var(--label-3)",
            fontSize: 12,
            fontWeight: 600,
            padding: 0,
          }}
        >
          {editingName ? "Done" : "Edit"}
        </button>
        <select
          value={view.channelId}
          onChange={(e) =>
            mutate({ kind: "channel", id: e.target.value }, () =>
              updatePartnerDetail(partner.id, { field: "channelId", value: e.target.value }),
            )
          }
          style={smallSelect}
        >
          {classifiers.channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          value={view.stageSlug}
          onChange={(e) =>
            mutate({ kind: "stage", slug: e.target.value }, () =>
              setPartnerStage(partner.id, e.target.value),
            )
          }
          style={smallSelect}
        >
          {classifiers.stages.map((s) => (
            <option key={s.id} value={s.slug}>
              {s.label}
            </option>
          ))}
        </select>
        {confirmingDelete ? (
          <button
            onClick={onDelete}
            disabled={deleting}
            style={{
              border: "none",
              cursor: "pointer",
              background: "none",
              color: "var(--accent)",
              fontSize: 12,
              fontWeight: 600,
              padding: 2,
              marginLeft: "auto",
            }}
          >
            {deleting ? "Deleting…" : "Sure?"}
          </button>
        ) : (
          <button
            className="hq-hover-accent"
            onClick={() => setConfirmingDelete(true)}
            style={{
              border: "none",
              cursor: "pointer",
              background: "none",
              color: "var(--label-3)",
              fontSize: 12,
              padding: 2,
              marginLeft: "auto",
            }}
          >
            Delete
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
        <label
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--label-3)" }}
        >
          Captain
          <input
            defaultValue={partner.captainName}
            onBlur={(e) => onCaptain(e.target.value)}
            style={{ ...smallSelect, width: 150 }}
          />
        </label>
        <label
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--label-3)" }}
        >
          Contact
          <input
            defaultValue={partner.captainContact}
            onBlur={(e) => onCaptainContact(e.target.value)}
            style={{ ...smallSelect, width: 170, fontFamily: "var(--mono)", fontSize: 12 }}
          />
        </label>
        <label
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--label-3)" }}
        >
          Target
          <input
            type="number"
            min={0}
            defaultValue={partner.target}
            onBlur={(e) => onTarget(e.target.value)}
            style={{ ...smallSelect, width: 64 }}
          />
        </label>
      </div>
      <div style={{ fontSize: 12, color: "var(--label-3)", marginTop: 8 }}>
        Last touched by {view.touchedBy}, {fmtDate(view.touchedAt ?? "")}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))",
          gap: 12,
          marginTop: 16,
          alignItems: "start",
        }}
      >
        <div style={card}>
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
                  fontSize: 14,
                  cursor: "pointer",
                  borderBottom: "1px solid var(--sep)",
                }}
              >
                <input
                  type="checkbox"
                  checked={done}
                  onChange={() =>
                    mutate({ kind: "exchange", itemId: x.id, done: !done }, () =>
                      togglePartnerExchange(partner.id, x.id, !done),
                    )
                  }
                  style={{ accentColor: "var(--accent)", width: 15, height: 15 }}
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
                fontSize: 13,
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
        <div style={card}>
          <div style={cardTitle}>Contact log</div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <input
              value={contactDraft}
              onChange={(e) => setContactDraft(e.target.value)}
              placeholder="Log an interaction"
              style={{ ...smallInput, flex: 1, minWidth: 0 }}
            />
            <button onClick={onAddContact} style={{ ...accentBtn, background: "var(--fill-3)" }}>
              Add
            </button>
          </div>
          {view.contacts.map((n) => (
            <div key={n.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--sep)" }}>
              <div style={{ fontSize: 12, color: "var(--label-3)" }}>
                {fmtWhen(n.createdAt, timezone)}, {n.author}
              </div>
              <div style={{ fontSize: 13, marginTop: 2 }}>{n.body}</div>
            </div>
          ))}
        </div>
        <div style={card}>
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
                  borderBottom: "1px solid var(--sep)",
                }}
              >
                <span style={{ fontSize: 14 }}>{t.name}</span>
                {status ? (
                  <Badge label={status.label} color={status.color} bg={`${status.color}-fill`} />
                ) : null}
              </div>
            );
          })}
          {view.teams.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--label-3)", marginTop: 10 }}>
              No projects attributed yet.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
