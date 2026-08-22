"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Fragment,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { IconBubbleAndPencil } from "@/components/hq/icons/IconBubbleAndPencil";
import { showToast } from "@/components/hq/toast";
import { Badge, FormField, accentBtn, input, pageTitle, primaryBtn } from "@/components/hq/ui";
import { CopyButton, useConfirmDelete, useSavedFlash } from "@/components/hq/ui-client";
import {
  addProjectMember,
  addProjectNote,
  createProject,
  editProjectNote,
  logMondayReview,
  removeProjectMember,
  saveProjectBlocker,
  setProjectForecast,
  setProjectStatus,
  toggleProjectGate,
  updateProjectDetail,
  updateProjectMember,
} from "@/lib/hq/actions/projects";
import { fmtDate, fmtWhen, isStale } from "@/lib/hq/format";
import type {
  Classifiers,
  NoteItem,
  Project,
  ProjectMember,
  Settings,
} from "@/lib/hq/types";

type PartnerOption = { id: string; name: string };
type EventOption = { id: string; name: string };

type ProjectPatch =
  | { kind: "status"; id: string; slug: string }
  | { kind: "forecast"; id: string; slug: string }
  | { kind: "gate"; id: string; gateId: string; done: boolean }
  | { kind: "partner"; id: string; partnerId: string | null; partnerName: string }
  | { kind: "memberAdd"; id: string; member: ProjectMember }
  | { kind: "memberRemove"; id: string; memberId: string }
  | { kind: "noteEdit"; id: string; noteId: string; body: string; editedAt: string };

function applyPatch(list: Project[], patch: ProjectPatch): Project[] {
  return list.map((p) => {
    if (p.id !== patch.id) return p;
    switch (patch.kind) {
      case "status":
        return { ...p, statusSlug: patch.slug };
      case "forecast":
        return { ...p, forecastSlug: patch.slug };
      case "gate":
        return {
          ...p,
          gates: patch.done
            ? [...p.gates, patch.gateId]
            : p.gates.filter((g) => g !== patch.gateId),
        };
      case "partner":
        return { ...p, partnerId: patch.partnerId, partnerName: patch.partnerName };
      case "memberAdd":
        return { ...p, members: [...p.members, patch.member] };
      case "memberRemove":
        return { ...p, members: p.members.filter((m) => m.id !== patch.memberId) };
      case "noteEdit":
        return {
          ...p,
          notes: p.notes.map((n) =>
            n.id === patch.noteId
              ? { ...n, body: patch.body, editedAt: patch.editedAt }
              : n,
          ),
        };
    }
  });
}

// Forecast UI values are the design's ("at risk"); the DB slug is "at_risk".
const uiForecast = (slug: string) => slug.replace(/_/g, " ");
const slugForecast = (ui: string) => ui.replace(/ /g, "_");

const filterSelect: React.CSSProperties = {
  padding: "7px 10px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "transparent",
  color: "var(--label-1)",
  fontSize: 13,
};

/** Micro-label in the details panel's left column (and the team modal). */
const microLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--label-3)",
};

/** Shared field style for the details panel and team modal inputs. */
const panelField: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 8px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "var(--card)",
  color: "var(--label-1)",
  fontSize: 13,
};

const gridColumns =
  "minmax(0,1.8fr) minmax(0,1.3fr) minmax(0,1.5fr) 92px 105px 130px 92px minmax(0,1.4fr)";

export function Projects({
  projects,
  partnerOptions,
  eventOptions,
  classifiers,
  settings,
  now,
  expandId,
}: {
  projects: Project[];
  partnerOptions: PartnerOption[];
  eventOptions: EventOption[];
  classifiers: Classifiers;
  settings: Settings;
  now: number;
  today: string;
  expandId: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [optimistic, patch] = useOptimistic(projects, applyPatch);

  const [reviewMode, setReviewMode] = useState(false);
  const [reviewLogged, setReviewLogged] = useState<Record<string, boolean>>({});
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projSearch, setProjSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [forecastFilter, setForecastFilter] = useState("");
  const [partnerFilter, setPartnerFilter] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [teamModalFor, setTeamModalFor] = useState<string | null>(null);
  // One commit path: every panel control saves on change or blur, and this
  // flash beside the "Details" heading is the only confirmation.
  const { phase: savedPhase, flash } = useSavedFlash();
  // Mirrors the design's instance-level draft map: drafts survive re-renders
  // and expand/collapse, and are only cleared where the design clears them.
  const drafts = useRef<Record<string, string | undefined>>({});
  const noteInputRef = useRef<HTMLInputElement | null>(null);
  // The note being rewritten, and its working copy. One at a time: the
  // timeline is narrow, and an open editor replaces the note's own row.
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState("");
  const prevExpandId = useRef<string | null>(null);

  useEffect(() => {
    if (expandId && expandId !== prevExpandId.current) {
      setExpandedId(expandId);
      setProjSearch("");
      setStatusFilter("");
      setForecastFilter("");
      setPartnerFilter("");
      setReviewMode(false);
      router.replace("/hq/projects");
    }
    prevExpandId.current = expandId;
  }, [expandId, router]);

  const gatesTotal = classifiers.gates.length;
  const statusBySlug = new Map(classifiers.statuses.map((s) => [s.slug, s]));
  const forecastBySlug = new Map(classifiers.forecasts.map((f) => [f.slug, f]));
  const srcOf = (p: Project) => [p.partnerName, p.eventSrc].filter(Boolean).join(", ");

  const pickStatus = (projectId: string, slug: string, review: boolean) => {
    startTransition(async () => {
      patch({ kind: "status", id: projectId, slug });
      await setProjectStatus(projectId, slug, review ? { review: true } : undefined);
    });
  };

  const pickForecast = (projectId: string, slug: string) => {
    startTransition(async () => {
      patch({ kind: "forecast", id: projectId, slug });
      await setProjectForecast(projectId, slug);
    });
  };

  const pickPartner = (projectId: string, partnerId: string) => {
    const partnerName = partnerOptions.find((o) => o.id === partnerId)?.name ?? "";
    startTransition(async () => {
      patch({ kind: "partner", id: projectId, partnerId: partnerId || null, partnerName });
      await updateProjectDetail(projectId, { field: "partnerId", value: partnerId || null });
    });
  };

  const toggleGate = (projectId: string, gateId: string, done: boolean) => {
    startTransition(async () => {
      patch({ kind: "gate", id: projectId, gateId, done });
      await toggleProjectGate(projectId, gateId, done);
    });
  };

  // A project may already name an event that isn't tracked (typed before the
  // picker existed, or since renamed). Keep it as an option so opening the
  // editor can't silently drop it.
  const eventOptionsFor = (current: string) =>
    current && !eventOptions.some((o) => o.name === current)
      ? [{ id: `current-${current}`, name: current }, ...eventOptions]
      : eventOptions;

  const saveDetail = (
    projectId: string,
    field: "leadName" | "leadContact" | "eventSrc",
    value: string,
  ) => {
    startTransition(async () => {
      await updateProjectDetail(projectId, { field, value });
    });
  };

  const saveBlocker = (projectId: string, value: string) => {
    startTransition(async () => {
      await saveProjectBlocker(projectId, value);
    });
  };

  const onAddMember = (projectId: string, name: string, contact: string) => {
    startTransition(async () => {
      patch({
        kind: "memberAdd",
        id: projectId,
        member: { id: `new-${Date.now()}`, name, contact },
      });
      await addProjectMember(projectId, name, contact);
    });
  };

  const onUpdateMember = (memberId: string, field: "name" | "contact", value: string) => {
    startTransition(async () => {
      await updateProjectMember(
        memberId,
        field === "name" ? { field: "name", value } : { field: "contact", value },
      );
    });
  };

  const onRemoveMember = (projectId: string, memberId: string) => {
    startTransition(async () => {
      patch({ kind: "memberRemove", id: projectId, memberId });
      await removeProjectMember(memberId);
    });
  };

  // Every chip in the Team row copies that person's contact; chips with no
  // contact recorded raise the toast without writing to the clipboard. The
  // toast repeats the handle so the copy can be eyeballed without pasting.
  const copyChip = (name: string, contact: string) => {
    if (contact) {
      if (navigator.clipboard) navigator.clipboard.writeText(contact).catch(() => {});
      showToast(`Copied ${name}'s contact - ${contact}`);
    } else {
      showToast(`No contact on file for ${name}`);
    }
  };

  const onCreateProject = () => {
    const d = drafts.current;
    if (!d.ProjName) return;
    const payload = {
      name: d.ProjName,
      leadName: d.ProjLead ?? "",
      leadContact: d.ProjContact ?? "",
      partnerId: d.ProjPartner || null,
      eventSrc: d.ProjEvent ?? "",
    };
    startTransition(async () => {
      await createProject(payload);
    });
    d.ProjName = d.ProjLead = d.ProjContact = d.ProjEvent = "";
    setNewProjectOpen(false);
  };

  const onLog = (p: Project) => {
    const blocker = drafts.current["rblk" + p.id];
    startTransition(async () => {
      await logMondayReview(p.id, blocker);
    });
    setReviewLogged((m) => ({ ...m, [p.id]: true }));
  };

  const onAddNote = (p: Project) => {
    const txt = drafts.current["note" + p.id];
    if (!txt) return;
    startTransition(async () => {
      await addProjectNote(p.id, txt);
    });
    drafts.current["note" + p.id] = "";
    if (noteInputRef.current) noteInputRef.current.value = "";
  };

  const onEditNote = (note: NoteItem) => {
    setEditingNoteId(note.id);
    setNoteEditDraft(note.body);
  };

  const onSaveNote = (projectId: string, note: NoteItem) => {
    const body = noteEditDraft.trim();
    setEditingNoteId(null);
    if (!body || body === note.body) return;
    startTransition(async () => {
      patch({
        kind: "noteEdit",
        id: projectId,
        noteId: note.id,
        body,
        editedAt: new Date().toISOString(),
      });
      await editProjectNote(note.id, body);
    });
  };

  const teamProject = teamModalFor
    ? (optimistic.find((x) => x.id === teamModalFor) ?? null)
    : null;

  const q = projSearch.toLowerCase();
  const filtered = optimistic.filter(
    (p) =>
      (!q || p.name.toLowerCase().includes(q) || p.leadName.toLowerCase().includes(q)) &&
      (!statusFilter || p.statusSlug === statusFilter) &&
      (!forecastFilter || uiForecast(p.forecastSlug) === forecastFilter) &&
      (!partnerFilter || p.partnerId === partnerFilter),
  );

  const statusFilters = [
    { value: "", label: "All" },
    ...classifiers.statuses.map((s) => ({ value: s.slug, label: s.label })),
  ];

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
          Projects <span style={{ fontWeight: 400, color: "var(--faded)" }}>{optimistic.length}</span>
        </h1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => {
              setReviewMode(!reviewMode);
              setReviewLogged({});
              setNewProjectOpen(false);
            }}
            style={{
              border: "none",
              cursor: "pointer",
              padding: "7px 14px",
              borderRadius: 0,
              fontSize: 14,
              fontWeight: 600,
              background: reviewMode ? "var(--label-1)" : "var(--fill-3)",
              color: reviewMode ? "var(--bg)" : "var(--accent-deep)",
            }}
          >
            {reviewMode ? "Exit review" : "Monday review"}
          </button>
          <button
            onClick={() => {
              setNewProjectOpen(!newProjectOpen);
              setReviewMode(false);
            }}
            style={primaryBtn}
          >
            New project
          </button>
        </div>
      </div>

      {newProjectOpen ? (
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
          <FormField label="Project name" flex={1} minWidth={160}>
            <input
              onChange={(e) => {
                drafts.current.ProjName = e.target.value;
              }}
              style={input}
            />
          </FormField>
          <FormField label="Lead (name)" flex={1} minWidth={140}>
            <input
              onChange={(e) => {
                drafts.current.ProjLead = e.target.value;
              }}
              style={input}
            />
          </FormField>
          <FormField label="Lead contact" flex={1} minWidth={140}>
            <input
              onChange={(e) => {
                drafts.current.ProjContact = e.target.value;
              }}
              placeholder="tg, x, or email"
              style={input}
            />
          </FormField>
          <FormField label="Source partner" minWidth={150}>
            <select
              onChange={(e) => {
                drafts.current.ProjPartner = e.target.value;
              }}
              style={input}
            >
              <option value="">None</option>
              {partnerOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Source event" minWidth={140}>
            <select
              onChange={(e) => {
                drafts.current.ProjEvent = e.target.value;
              }}
              style={input}
            >
              <option value="">None</option>
              {eventOptions.map((o) => (
                <option key={o.id} value={o.name}>
                  {o.name}
                </option>
              ))}
            </select>
          </FormField>
          <button
            onClick={onCreateProject}
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

      {reviewMode ? (
        <>
          <div
            style={{
              background: "var(--accent-fill)",
              borderRadius: 0,
              padding: "10px 14px",
              marginTop: 14,
              fontSize: 13,
              color: "var(--label-1)",
            }}
          >
            <span style={{ fontWeight: 600, color: "var(--accent)" }}>Monday review.</span> Set a
            status, note one blocker, then Log. Each log stamps today as the check-in date.
          </div>
          <div
            style={{
              background: "var(--card)",
              borderRadius: 0,
              boxShadow: "var(--shadow-1)",
              marginTop: 12,
              overflow: "hidden",
            }}
          >
            {optimistic.map((p) => (
              <div
                key={p.id}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  padding: "10px 16px",
                  borderBottom: "1px solid var(--sep)",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 600, width: 150, flex: "none" }}>
                  {p.name}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--label-3)",
                    width: 78,
                    flex: "none",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {fmtDate(p.lastCheckIn)}
                </span>
                <div style={{ display: "flex", gap: 4, flex: "none" }}>
                  {classifiers.statuses.map((s) => {
                    const selected = p.statusSlug === s.slug;
                    return (
                      <button
                        key={s.id}
                        onClick={() => pickStatus(p.id, s.slug, true)}
                        style={{
                          border: "none",
                          cursor: "pointer",
                          padding: "5px 12px",
                          borderRadius: 2,
                          fontSize: 11,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          background: selected ? `var(--${s.color})` : "var(--fill-3)",
                          color: selected ? "#fff" : "var(--label-2)",
                        }}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
                <input
                  onChange={(e) => {
                    drafts.current["rblk" + p.id] = e.target.value;
                  }}
                  defaultValue={p.blocker}
                  placeholder="One blocker, or leave clear"
                  style={{
                    flex: 1,
                    minWidth: 160,
                    padding: "7px 10px",
                    border: "1px solid var(--sep)",
                    borderRadius: 0,
                    background: "transparent",
                    color: "var(--label-1)",
                    fontSize: 13,
                  }}
                />
                {reviewLogged[p.id] ? (
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--green)",
                      padding: "6px 14px",
                    }}
                  >
                    Logged
                  </span>
                ) : (
                  <button
                    onClick={() => onLog(p)}
                    style={{
                      border: "none",
                      cursor: "pointer",
                      padding: "6px 14px",
                      borderRadius: 0,
                      fontSize: 13,
                      fontWeight: 600,
                      background: "var(--fill-3)",
                      color: "var(--accent)",
                    }}
                  >
                    Log
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              gap: 8,
              marginTop: 14,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <input
              value={projSearch}
              onChange={(e) => setProjSearch(e.target.value)}
              placeholder="Filter by name or lead"
              style={{
                padding: "8px 12px",
                border: "1px solid var(--sep)",
                borderRadius: 0,
                background: "transparent",
                color: "var(--label-1)",
                fontSize: 14,
                width: 190,
              }}
            />
            <div style={{ display: "flex", boxShadow: "0 0 0 1px var(--sep)", padding: 2 }}>
              {statusFilters.map((s) => {
                const selected = statusFilter === s.value;
                return (
                  <button
                    key={s.value}
                    onClick={() => setStatusFilter(s.value)}
                    style={{
                      border: "none",
                      cursor: "pointer",
                      padding: "5px 12px",
                      borderRadius: 0,
                      fontSize: 13,
                      background: selected ? "var(--label-1)" : "none",
                      color: selected ? "var(--bg)" : "var(--label-2)",
                      fontWeight: selected ? 600 : 400,
                    }}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
            <select
              value={forecastFilter}
              onChange={(e) => setForecastFilter(e.target.value)}
              style={filterSelect}
            >
              <option value="">All forecasts</option>
              {classifiers.forecasts.map((f) => (
                <option key={f.id} value={uiForecast(f.slug)}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              value={partnerFilter}
              onChange={(e) => setPartnerFilter(e.target.value)}
              style={filterSelect}
            >
              <option value="">All sources</option>
              {partnerOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <div
            style={{
              background: "var(--card)",
              borderRadius: 0,
              boxShadow: "var(--shadow-1)",
              marginTop: 12,
              overflowX: "auto",
            }}
          >
            <div style={{ minWidth: 940 }}>
              <div
                style={{
                  display: "grid",
                  textAlign: "left",
                  overflowWrap: "break-word",
                  gridTemplateColumns: gridColumns,
                  gap: 10,
                  padding: "10px 16px",
                  borderBottom: "1px solid var(--sep)",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--label-3)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                <span>Project</span>
                <span>Lead</span>
                <span>Source</span>
                <span>Status</span>
                <span>Forecast</span>
                <span>Gates</span>
                <span>Check-in</span>
                <span>Blocker</span>
              </div>
              {filtered.map((p) => {
                const done = p.gates.length;
                const stale = isStale(p.lastCheckIn, settings.staleDays, now);
                const expanded = expandedId === p.id;
                const status = statusBySlug.get(p.statusSlug);
                const source = srcOf(p) || "Direct";
                return (
                  <Fragment key={p.id}>
                    <div
                      onClick={() => {
                        setExpandedId(expanded ? null : p.id);
                        setEditingNoteId(null);
                      }}
                      className="hq-row-hover"
                      style={{
                        display: "grid",
                        textAlign: "left",
                        overflowWrap: "break-word",
                        gridTemplateColumns: gridColumns,
                        gap: 10,
                        padding: "11px 16px",
                        borderBottom: "1px solid var(--sep)",
                        fontSize: 14,
                        cursor: "pointer",
                        alignItems: "center",
                        background: expanded ? "var(--fill-4)" : undefined,
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{p.name}</span>
                      <span style={{ color: "var(--label-2)" }}>{p.leadName}</span>
                      <span style={{ color: "var(--label-2)", fontSize: 13 }}>{source}</span>
                      <span>
                        {status ? (
                          <Badge
                            label={status.label}
                            color={status.color}
                            bg={`${status.color}-fill`}
                          />
                        ) : null}
                      </span>
                      <span style={{ fontSize: 13, color: "var(--label-2)" }}>
                        {forecastBySlug.get(p.forecastSlug)?.label ?? ""}
                      </span>
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            flex: 1,
                            height: 4,
                            borderRadius: 0,
                            background: "var(--fill-3)",
                            overflow: "hidden",
                          }}
                        >
                          <span
                            style={{
                              display: "block",
                              height: "100%",
                              borderRadius: 0,
                              background: "var(--accent)",
                              width: `${gatesTotal ? (done / gatesTotal) * 100 : 0}%`,
                            }}
                          />
                        </span>
                        <span
                          style={{
                            fontSize: 12,
                            color: "var(--label-2)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {done}/{gatesTotal}
                        </span>
                      </span>
                      <span
                        style={{
                          fontSize: 13,
                          color: stale ? "var(--red)" : "var(--label-2)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {fmtDate(p.lastCheckIn)}
                      </span>
                      <span
                        style={{
                          fontSize: 13,
                          color: "var(--label-2)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.blocker || ""}
                      </span>
                    </div>
                    {expanded ? (
                      <div
                        className="hq-fade-in"
                        style={{
                          padding: "18px 16px",
                          borderBottom: "1px solid var(--sep)",
                          background: "var(--fill-4)",
                        }}
                      >
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))",
                            gap: 20,
                          }}
                        >
                          <div>
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "var(--label-3)",
                                textTransform: "uppercase",
                                letterSpacing: "0.04em",
                                marginBottom: 8,
                              }}
                            >
                              Submission gates
                            </div>
                            {classifiers.gates.map((g) => {
                              const gateDone = p.gates.includes(g.id);
                              return (
                                <label
                                  key={g.id}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    padding: "5px 0",
                                    fontSize: 14,
                                    cursor: "pointer",
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={gateDone}
                                    onChange={(e) => {
                                      e.stopPropagation();
                                      toggleGate(p.id, g.id, !gateDone);
                                    }}
                                    style={{
                                      accentColor: "var(--accent)",
                                      width: 15,
                                      height: 15,
                                    }}
                                  />
                                  <span
                                    style={{
                                      color: gateDone ? "var(--label-3)" : "var(--label-1)",
                                    }}
                                  >
                                    {g.label}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                          <div>
                            {/* minHeight reserves the flash's line so it can't
                                shift the panel when it appears. */}
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "baseline",
                                marginBottom: 4,
                                minHeight: 18,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 13,
                                  fontWeight: 600,
                                  color: "var(--label-3)",
                                  textTransform: "uppercase",
                                  letterSpacing: "0.04em",
                                }}
                              >
                                Details
                              </span>
                              {savedPhase !== "hidden" && (
                                <span
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 600,
                                    color: "var(--green)",
                                    opacity: savedPhase === "fading" ? 0 : 1,
                                    transition: "opacity 600ms ease",
                                  }}
                                >
                                  Saved
                                </span>
                              )}
                            </div>
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "62px minmax(0,1fr)",
                                columnGap: 10,
                                rowGap: 7,
                                alignItems: "center",
                              }}
                            >
                              <span style={microLabel}>Lead</span>
                              <input
                                defaultValue={p.leadName}
                                onBlur={(e) => {
                                  if (e.target.value !== p.leadName) {
                                    saveDetail(p.id, "leadName", e.target.value);
                                    flash();
                                  }
                                }}
                                style={panelField}
                              />
                              <span style={microLabel}>Contact</span>
                              <div style={{ display: "flex", gap: 6, minWidth: 0 }}>
                                <input
                                  defaultValue={p.leadContact}
                                  onBlur={(e) => {
                                    if (e.target.value !== p.leadContact) {
                                      saveDetail(p.id, "leadContact", e.target.value);
                                      flash();
                                    }
                                  }}
                                  aria-label="Lead contact"
                                  placeholder="tg, x, or email"
                                  style={{
                                    ...panelField,
                                    flex: 1,
                                    minWidth: 0,
                                    fontFamily: "var(--mono)",
                                    fontSize: 12,
                                  }}
                                />
                                <CopyButton value={p.leadContact} />
                              </div>
                              <span style={microLabel}>Team</span>
                              <div
                                style={{
                                  display: "flex",
                                  flexWrap: "wrap",
                                  gap: 5,
                                  alignItems: "center",
                                }}
                              >
                                {/* The lead is always on the team: first, always
                                    present, not removable. */}
                                <button
                                  className="hq-chip-lead"
                                  onClick={() => copyChip(p.leadName, p.leadContact)}
                                  title={
                                    p.leadContact
                                      ? `Copy ${p.leadContact}`
                                      : "No contact on file"
                                  }
                                  style={{
                                    border: "none",
                                    cursor: "pointer",
                                    fontSize: 12,
                                    padding: "4px 8px",
                                    fontWeight: 600,
                                  }}
                                >
                                  {p.leadName}
                                </button>
                                {p.members.map((m) => (
                                  <button
                                    key={m.id}
                                    className="hq-chip-member"
                                    onClick={() => copyChip(m.name, m.contact)}
                                    title={
                                      m.contact ? `Copy ${m.contact}` : "No contact on file"
                                    }
                                    style={{
                                      border: "none",
                                      cursor: "pointer",
                                      fontSize: 12,
                                      padding: "4px 8px",
                                    }}
                                  >
                                    {m.name}
                                  </button>
                                ))}
                                <button
                                  onClick={() => setTeamModalFor(p.id)}
                                  style={{ ...accentBtn, padding: "4px 9px", fontSize: 12 }}
                                >
                                  {p.members.length ? "Edit" : "Add"}
                                </button>
                              </div>
                              <span style={microLabel}>Partner</span>
                              <select
                                value={p.partnerId ?? ""}
                                onChange={(e) => {
                                  pickPartner(p.id, e.target.value);
                                  flash();
                                }}
                                style={panelField}
                              >
                                <option value="">No partner</option>
                                {partnerOptions.map((o) => (
                                  <option key={o.id} value={o.id}>
                                    {o.name}
                                  </option>
                                ))}
                              </select>
                              <span style={microLabel}>Event</span>
                              <select
                                defaultValue={p.eventSrc}
                                onChange={(e) => {
                                  saveDetail(p.id, "eventSrc", e.target.value);
                                  flash();
                                }}
                                style={panelField}
                              >
                                <option value="">No source event</option>
                                {eventOptionsFor(p.eventSrc).map((o) => (
                                  <option key={o.id} value={o.name}>
                                    {o.name}
                                  </option>
                                ))}
                              </select>
                              <span style={microLabel}>Status</span>
                              {/* Status is the panel's most-changed field; one
                                  click beats opening a select. No review flag —
                                  only Monday review stamps the check-in date. */}
                              <div style={{ display: "flex", gap: 4 }}>
                                {classifiers.statuses.map((s) => {
                                  const selected = p.statusSlug === s.slug;
                                  return (
                                    <button
                                      key={s.id}
                                      aria-pressed={selected}
                                      onClick={() => {
                                        pickStatus(p.id, s.slug, false);
                                        flash();
                                      }}
                                      style={{
                                        border: "none",
                                        cursor: "pointer",
                                        padding: "5px 11px",
                                        borderRadius: 2,
                                        fontSize: 11,
                                        fontWeight: 600,
                                        textTransform: "uppercase",
                                        letterSpacing: "0.08em",
                                        background: selected
                                          ? `var(--${s.color})`
                                          : "var(--fill-3)",
                                        color: selected ? "#fff" : "var(--label-2)",
                                      }}
                                    >
                                      {s.label}
                                    </button>
                                  );
                                })}
                              </div>
                              <span style={microLabel}>Forecast</span>
                              <select
                                value={uiForecast(p.forecastSlug)}
                                onChange={(e) => {
                                  pickForecast(p.id, slugForecast(e.target.value));
                                  flash();
                                }}
                                style={panelField}
                              >
                                {classifiers.forecasts.map((f) => (
                                  <option key={f.id} value={uiForecast(f.slug)}>
                                    {f.label}
                                  </option>
                                ))}
                              </select>
                              <span style={microLabel}>Blocker</span>
                              <input
                                defaultValue={p.blocker}
                                placeholder="None"
                                onBlur={(e) => {
                                  if (e.target.value !== p.blocker) {
                                    saveBlocker(p.id, e.target.value);
                                    flash();
                                  }
                                }}
                                style={panelField}
                              />
                            </div>
                            <div style={{ fontSize: 12, color: "var(--label-3)", marginTop: 12 }}>
                              Last touched by {p.touchedBy}
                              {p.touchedAt ? `, ${fmtDate(p.touchedAt)}` : ""}. Changes save as
                              you make them.
                            </div>
                          </div>
                          <div>
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "var(--label-3)",
                                textTransform: "uppercase",
                                letterSpacing: "0.04em",
                                marginBottom: 8,
                              }}
                            >
                              Timeline
                            </div>
                            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                              <input
                                ref={noteInputRef}
                                onChange={(e) => {
                                  drafts.current["note" + p.id] = e.target.value;
                                }}
                                placeholder="Add a note"
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  padding: "7px 10px",
                                  border: "1px solid var(--sep)",
                                  borderRadius: 0,
                                  background: "var(--card)",
                                  color: "var(--label-1)",
                                  fontSize: 13,
                                }}
                              />
                              <button onClick={() => onAddNote(p)} style={accentBtn}>
                                Add
                              </button>
                            </div>
                            {p.notes.map((n) => {
                              const editing = editingNoteId === n.id;
                              return (
                                <div
                                  key={n.id}
                                  style={{
                                    padding: "6px 0",
                                    borderBottom: "1px solid var(--sep)",
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 8,
                                      fontSize: 12,
                                      color: "var(--label-3)",
                                    }}
                                  >
                                    <span style={{ flex: 1, minWidth: 0 }}>
                                      {fmtWhen(n.createdAt, settings.timezone)}, {n.author}
                                      {n.editedAt
                                        ? ` (edited ${fmtWhen(n.editedAt, settings.timezone)})`
                                        : ""}
                                    </span>
                                    <button
                                      className="hq-hover-accent"
                                      onClick={() =>
                                        editing ? setEditingNoteId(null) : onEditNote(n)
                                      }
                                      title={editing ? "Stop editing" : "Edit note"}
                                      aria-label={editing ? "Stop editing" : "Edit note"}
                                      style={{
                                        flex: "none",
                                        display: "inline-flex",
                                        border: "none",
                                        cursor: "pointer",
                                        background: "none",
                                        padding: 2,
                                        color: editing ? "var(--accent)" : "var(--label-3)",
                                      }}
                                    >
                                      <IconBubbleAndPencil style={{ display: "block" }} />
                                    </button>
                                  </div>
                                  {editing ? (
                                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                                      <input
                                        autoFocus
                                        value={noteEditDraft}
                                        onChange={(e) => setNoteEditDraft(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") onSaveNote(p.id, n);
                                          if (e.key === "Escape") setEditingNoteId(null);
                                        }}
                                        style={{ ...panelField, flex: 1, minWidth: 0 }}
                                      />
                                      <button
                                        onClick={() => onSaveNote(p.id, n)}
                                        style={{ ...accentBtn, flex: "none" }}
                                      >
                                        Save
                                      </button>
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: 13, marginTop: 2 }}>{n.body}</div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </Fragment>
                );
              })}
            </div>
          </div>
          {/* Demo day is used on one day of the campaign, so it is entered
              from here rather than holding a permanent navbar tab. Same
              ghost treatment as the "Archived {n}" button on Events. */}
          <div style={{ display: "flex", justifyContent: "flex-start", marginTop: 14 }}>
            <Link
              href="/hq/demo"
              className="hq-ghost-btn"
              style={{
                border: "none",
                cursor: "pointer",
                padding: "8px 14px",
                fontSize: 13,
                fontWeight: 600,
                boxShadow: "0 0 0 1px var(--sep)",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                textDecoration: "none",
              }}
            >
              Demo day
              <span style={{ color: "var(--faded)" }}>&#8250;</span>
            </Link>
          </div>
        </>
      )}
      {teamProject ? (
        <TeamModal
          project={teamProject}
          onClose={() => setTeamModalFor(null)}
          onAdd={(name, contact) => onAddMember(teamProject.id, name, contact)}
          onUpdate={onUpdateMember}
          onRemove={(memberId) => onRemoveMember(teamProject.id, memberId)}
        />
      ) : null}
    </div>
  );
}

// Name · contact · action, shared by the lead row, member rows, and add row.
const teamModalGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0,1fr) minmax(0,1.1fr) 58px",
  columnGap: 10,
  alignItems: "center",
};

/**
 * Same shell as ScoreModal in demo-day.tsx, at 380 wide — it holds three
 * columns, not a form. The lead row is read-only: the lead is edited in
 * the details panel.
 */
function TeamModal({
  project,
  onClose,
  onAdd,
  onUpdate,
  onRemove,
}: {
  project: Project;
  onClose: () => void;
  onAdd: (name: string, contact: string) => void;
  onUpdate: (memberId: string, field: "name" | "contact", value: string) => void;
  onRemove: (memberId: string) => void;
}) {
  const armed = useConfirmDelete();
  const [nameDraft, setNameDraft] = useState("");
  const [contactDraft, setContactDraft] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const add = () => {
    const name = nameDraft.trim();
    if (!name) return;
    onAdd(name, contactDraft.trim());
    setNameDraft("");
    setContactDraft("");
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(22,19,15,0.35)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "12vh 16px 16px",
      }}
    >
      <div
        className="hq-pop-in-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380,
          maxWidth: "100%",
          boxSizing: "border-box",
          background: "var(--card)",
          boxShadow: "var(--shadow-pop)",
          padding: "20px 22px",
          transformOrigin: "top center",
        }}
      >
        <div style={{ fontFamily: "var(--serif)", fontSize: 24, fontWeight: 400 }}>
          {project.name} team
        </div>
        <div style={{ fontSize: 13, color: "var(--label-2)", marginTop: 2 }}>
          The lead is always on the team.
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 14 }}>
          <div
            style={{
              ...teamModalGrid,
              padding: "9px 0",
              borderBottom: "1px solid var(--sep)",
            }}
          >
            <span
              style={{
                fontSize: 14,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {project.leadName}
            </span>
            <span
              style={{
                fontSize: 12,
                color: "var(--label-2)",
                fontFamily: "var(--mono)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {project.leadContact}
            </span>
            <span style={{ justifySelf: "end" }}>
              <Badge label="Lead" color="accent" bg="accent-fill" />
            </span>
          </div>
          {project.members.map((m) => {
            const del = armed(`mem-${m.id}`, "Remove", () => onRemove(m.id));
            return (
              <div
                key={m.id}
                style={{
                  ...teamModalGrid,
                  padding: "7px 0",
                  borderBottom: "1px solid var(--sep)",
                }}
              >
                <input
                  defaultValue={m.name}
                  aria-label="Teammate name"
                  onBlur={(e) => {
                    const value = e.target.value.trim();
                    if (value && value !== m.name) onUpdate(m.id, "name", value);
                  }}
                  style={panelField}
                />
                <input
                  defaultValue={m.contact}
                  aria-label="Teammate contact"
                  placeholder="tg, x, or email"
                  onBlur={(e) => {
                    if (e.target.value !== m.contact)
                      onUpdate(m.id, "contact", e.target.value);
                  }}
                  style={{ ...panelField, fontFamily: "var(--mono)", fontSize: 12 }}
                />
                <button
                  className="hq-hover-accent"
                  onClick={del.onClick}
                  title={del.title}
                  style={{
                    justifySelf: "end",
                    border: "none",
                    cursor: "pointer",
                    background: "none",
                    color: del.color,
                    fontSize: 12,
                    fontWeight: del.fontWeight,
                    padding: 2,
                    whiteSpace: "nowrap",
                  }}
                >
                  {del.label}
                </button>
              </div>
            );
          })}
        </div>
        <div style={{ ...teamModalGrid, marginTop: 14 }}>
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder="Name"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 10px",
              border: "1px solid var(--sep)",
              borderRadius: 0,
              background: "transparent",
              color: "var(--label-1)",
              fontSize: 13,
            }}
          />
          <input
            value={contactDraft}
            onChange={(e) => setContactDraft(e.target.value)}
            placeholder="tg, x, or email"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 10px",
              border: "1px solid var(--sep)",
              borderRadius: 0,
              background: "transparent",
              color: "var(--label-1)",
              fontFamily: "var(--mono)",
              fontSize: 12,
            }}
          />
          <button onClick={add} style={{ ...accentBtn, width: "100%", padding: "8px 4px" }}>
            Add
          </button>
        </div>
        <button
          onClick={onClose}
          style={{ ...primaryBtn, width: "100%", marginTop: 14, padding: 9 }}
        >
          Done
        </button>
      </div>
    </div>
  );
}
