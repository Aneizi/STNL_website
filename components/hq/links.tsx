"use client";

import { Fragment, useOptimistic, useState, useTransition } from "react";
import { IconBubbleAndPencil } from "@/components/hq/icons/IconBubbleAndPencil";
import { IconSparkles } from "@/components/hq/icons/IconSparkles";
import { showToast } from "@/components/hq/toast";
import { FormField, accentBtn, card, input, pageTitle, primaryBtn } from "@/components/hq/ui";
import { useConfirmDelete } from "@/components/hq/ui-client";
import {
  addLinkNote,
  createLink,
  deleteLink,
  setLinkHighlighted,
  updateLink,
} from "@/lib/hq/actions/links";
import { fmtWhen } from "@/lib/hq/format";
import { HIGHLIGHT_CAP, type HqLink, type NoteItem } from "@/lib/hq/types";

type LinkPatch =
  | { kind: "create"; link: HqLink }
  | { kind: "highlight"; id: string; on: boolean }
  | { kind: "note"; id: string; note: NoteItem }
  | { kind: "edit"; id: string; title: string; url: string };

function applyPatch(list: HqLink[], patch: LinkPatch): HqLink[] {
  switch (patch.kind) {
    case "create":
      return [patch.link, ...list];
    case "highlight":
      return list.map((l) => (l.id === patch.id ? { ...l, highlighted: patch.on } : l));
    case "note":
      return list.map((l) =>
        l.id === patch.id ? { ...l, notes: [patch.note, ...l.notes] } : l,
      );
    case "edit":
      return list.map((l) =>
        l.id === patch.id ? { ...l, title: patch.title, url: patch.url } : l,
      );
  }
}

// Title · Link · Notes · actions. The action track carries the highlight
// star, the edit pencil and the two-step delete, and is sized for its widest
// state — star + "Sure?", or Save + Discard while a row is being edited — so
// nothing in it is ever clipped.
const GRID = "minmax(0,1.3fr) minmax(0,2fr) 78px 116px";

/** Editing happens in the row itself, so the fields sit on the row's own
 *  line height and inherit its type; only a hairline marks them out. */
const rowField: React.CSSProperties = {
  flex: 1,
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  padding: "4px 6px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "var(--card)",
  color: "var(--label-1)",
  fontSize: 14,
};

/** Text button in the row's action track (Save, Discard, ×, Sure?). */
const rowAction: React.CSSProperties = {
  border: "none",
  cursor: "pointer",
  background: "none",
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1,
  padding: 2,
  whiteSpace: "nowrap",
};

export function Links({
  links,
  timezone,
  userName,
}: {
  links: HqLink[];
  timezone: string;
  userName: string;
}) {
  const [, startTransition] = useTransition();
  const [optimistic, patch] = useOptimistic(links, applyPatch);
  // Deleted rows vanish immediately; useOptimistic cannot express a removal.
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(new Set());
  const [newLinkOpen, setNewLinkOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // "Visible on hover" needs the row's hover state, which the highlight
  // button can't read from CSS alone — track the hovered row id here.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  // The link being edited, plus its working title/URL. Editing happens in the
  // expanded panel, so the row itself keeps its shape while the form is open.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const armed = useConfirmDelete();

  const visible = optimistic.filter((l) => !deletedIds.has(l.id));
  const highlightedCount = visible.filter((l) => l.highlighted).length;
  // Highlighted links sort first; returning 0 for ties keeps the query's
  // newest-first order within each group (Array#sort is stable).
  const sorted = [...visible].sort((a, b) =>
    a.highlighted === b.highlighted ? 0 : a.highlighted ? -1 : 1,
  );

  const onAddLink = () => {
    const title = titleDraft.trim();
    let url = urlDraft.trim();
    if (!title || !url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    setNewLinkOpen(false);
    setTitleDraft("");
    setUrlDraft("");
    startTransition(async () => {
      patch({
        kind: "create",
        link: { id: `new-${Date.now()}`, title, url, highlighted: false, notes: [] },
      });
      await createLink({ title, url });
    });
  };

  const onToggleHighlight = (l: HqLink) => {
    if (!l.highlighted && highlightedCount >= HIGHLIGHT_CAP) {
      showToast(`Highlight limit reached — ${HIGHLIGHT_CAP} max`);
      return;
    }
    startTransition(async () => {
      patch({ kind: "highlight", id: l.id, on: !l.highlighted });
      const res = await setLinkHighlighted(l.id, !l.highlighted);
      if (!res.ok && res.error) showToast(res.error);
    });
  };

  const onAddNote = (l: HqLink) => {
    const body = (noteDrafts[l.id] ?? "").trim();
    if (!body) return;
    setNoteDrafts((d) => ({ ...d, [l.id]: "" }));
    startTransition(async () => {
      patch({
        kind: "note",
        id: l.id,
        note: {
          id: `optimistic-${Date.now()}`,
          author: userName,
          body,
          createdAt: new Date().toISOString(),
        },
      });
      await addLinkNote(l.id, body);
    });
  };

  const onStartEdit = (l: HqLink) => {
    setEditingId(l.id);
    setEditTitle(l.title);
    setEditUrl(l.url);
  };

  const onSaveEdit = (l: HqLink) => {
    const title = editTitle.trim();
    let url = editUrl.trim();
    if (!title || !url) {
      showToast("Title and link are required.");
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    setEditingId(null);
    if (title === l.title && url === l.url) return;
    startTransition(async () => {
      patch({ kind: "edit", id: l.id, title, url });
      const res = await updateLink(l.id, { title, url });
      if (!res.ok && res.error) showToast(res.error);
    });
  };

  const onDelete = (l: HqLink) => {
    setDeletedIds((ids) => new Set(ids).add(l.id));
    startTransition(async () => {
      await deleteLink(l.id);
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
          Links <span style={{ fontWeight: 400, color: "var(--faded)" }}>{visible.length}</span>
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              fontSize: 13,
              color: highlightedCount >= HIGHLIGHT_CAP ? "var(--orange)" : "var(--label-3)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {highlightedCount} of {HIGHLIGHT_CAP} highlighted
          </span>
          <button onClick={() => setNewLinkOpen(!newLinkOpen)} style={primaryBtn}>
            New link
          </button>
        </div>
      </div>

      {newLinkOpen ? (
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
          <FormField label="Title" flex={1} minWidth={160}>
            <input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              style={input}
            />
          </FormField>
          <FormField label="Link" flex={2} minWidth={220}>
            <input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://"
              style={{ ...input, fontFamily: "var(--mono)", fontSize: 13 }}
            />
          </FormField>
          <button onClick={onAddLink} style={{ ...primaryBtn, padding: "9px 16px" }}>
            Add
          </button>
        </div>
      ) : null}

      <div
        style={{
          background: "var(--card)",
          boxShadow: "var(--shadow-1)",
          marginTop: 16,
          overflowX: "auto",
        }}
      >
        <div style={{ minWidth: 640 }}>
          <div
            style={{
              display: "grid",
              textAlign: "left",
              gridTemplateColumns: GRID,
              columnGap: 16,
              padding: "10px 16px",
              borderBottom: "1px solid var(--sep)",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--label-3)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            <span>Title</span>
            <span>Link</span>
            <span>Notes</span>
            <span />
          </div>
          {sorted.map((l) => {
            const expanded = expandedId === l.id;
            const editing = editingId === l.id;
            const del = armed(`link-${l.id}`, "×", () => onDelete(l));
            const highlightTitle = l.highlighted
              ? "Remove highlight"
              : highlightedCount >= HIGHLIGHT_CAP
                ? `Highlight limit reached (${HIGHLIGHT_CAP})`
                : "Highlight and pin to top";
            return (
              <Fragment key={l.id}>
                <div
                  onClick={() => {
                    if (editing) return;
                    setExpandedId(expanded ? null : l.id);
                  }}
                  onMouseEnter={() => setHoveredId(l.id)}
                  onMouseLeave={() =>
                    setHoveredId((cur) => (cur === l.id ? null : cur))
                  }
                  className="hq-row-hover"
                  style={{
                    display: "grid",
                    textAlign: "left",
                    gridTemplateColumns: GRID,
                    columnGap: 16,
                    padding: "11px 16px",
                    borderBottom: "1px solid var(--sep)",
                    fontSize: 14,
                    cursor: editing ? "default" : "pointer",
                    alignItems: "center",
                    background: expanded ? "var(--fill-4)" : undefined,
                  }}
                >
                  {editing ? (
                    <input
                      autoFocus
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onSaveEdit(l);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      aria-label="Link title"
                      style={{ ...rowField, fontWeight: 600 }}
                    />
                  ) : (
                    <span
                      style={{
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {l.title}
                    </span>
                  )}
                  {editing ? (
                    <input
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onSaveEdit(l);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      placeholder="https://"
                      aria-label="Link URL"
                      style={{ ...rowField, fontFamily: "var(--mono)", fontSize: 12 }}
                    />
                  ) : (
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        display: "block",
                        minWidth: 0,
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {l.url}
                    </a>
                  )}
                  <span
                    style={{
                      fontSize: 13,
                      color: l.notes.length ? "var(--label-2)" : "var(--faded)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {l.notes.length}
                  </span>
                  <div
                    style={{
                      justifySelf: "end",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    {/* Hidden with opacity (not display) so the row never
                        reflows and the button stays keyboard-reachable. */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleHighlight(l);
                      }}
                      title={highlightTitle}
                      aria-label={highlightTitle}
                      style={{
                        ...rowAction,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "0 2px",
                        color: l.highlighted ? "var(--orange)" : "var(--label-3)",
                        opacity: editing ? 0 : l.highlighted || hoveredId === l.id ? 1 : 0,
                        pointerEvents: editing ? "none" : undefined,
                        transition: "opacity 120ms, color 120ms",
                      }}
                    >
                      <IconSparkles width={14} height={18} style={{ display: "block" }} />
                    </button>
                    {editing ? (
                      <>
                        <button
                          className="hq-hover-accent"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSaveEdit(l);
                          }}
                          style={{ ...rowAction, color: "var(--accent)" }}
                        >
                          Save
                        </button>
                        <button
                          className="hq-hover-accent"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(null);
                          }}
                          style={{ ...rowAction, color: "var(--label-3)" }}
                        >
                          Discard
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="hq-hover-accent"
                          onClick={(e) => {
                            e.stopPropagation();
                            onStartEdit(l);
                          }}
                          title="Edit title and link"
                          aria-label="Edit title and link"
                          style={{
                            ...rowAction,
                            display: "inline-flex",
                            color: "var(--label-3)",
                          }}
                        >
                          <IconBubbleAndPencil style={{ display: "block" }} />
                        </button>
                        {/* The × is a glyph, not an icon: it needs a larger
                            type size than "Sure?" to read at the same weight
                            as the star and pencil beside it. */}
                        <button
                          className="hq-hover-accent"
                          onClick={del.onClick}
                          title={del.title}
                          style={{
                            ...rowAction,
                            color: del.color,
                            fontWeight: del.fontWeight,
                            fontSize: del.armed ? 12 : 18,
                          }}
                        >
                          {del.label}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {expanded ? (
                  <div
                    className="hq-fade-in"
                    style={{
                      padding: 16,
                      borderBottom: "1px solid var(--sep)",
                      background: "var(--fill-4)",
                    }}
                  >
                    {/* Notes are prose — full table width hurts readability. */}
                    <div style={{ maxWidth: 620 }}>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          color: "var(--label-3)",
                        }}
                      >
                        Notes
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <input
                          value={noteDrafts[l.id] ?? ""}
                          onChange={(e) =>
                            setNoteDrafts((d) => ({ ...d, [l.id]: e.target.value }))
                          }
                          placeholder="Add a note"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            boxSizing: "border-box",
                            padding: "7px 10px",
                            border: "1px solid var(--sep)",
                            borderRadius: 0,
                            background: "var(--card)",
                            color: "var(--label-1)",
                            fontSize: 13,
                          }}
                        />
                        <button
                          onClick={() => onAddNote(l)}
                          style={{ ...accentBtn, flex: "none" }}
                        >
                          Add
                        </button>
                      </div>
                      {l.notes.map((n) => (
                        <div
                          key={n.id}
                          style={{ padding: "8px 0", borderBottom: "1px solid var(--sep)" }}
                        >
                          <div style={{ fontSize: 12, color: "var(--label-3)" }}>
                            {fmtWhen(n.createdAt, timezone)}, {n.author}
                          </div>
                          <div style={{ fontSize: 13, marginTop: 2 }}>{n.body}</div>
                        </div>
                      ))}
                      {l.notes.length === 0 ? (
                        <div
                          style={{ fontSize: 13, color: "var(--label-3)", padding: "10px 0" }}
                        >
                          Nothing noted yet.
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
