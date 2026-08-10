"use client";

import { useRouter } from "next/navigation";
import {
  Fragment,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { Badge, FormField, accentBtn, input, pageTitle, primaryBtn } from "@/components/hq/ui";
import {
  addProjectNote,
  createProject,
  logMondayReview,
  saveProjectBlocker,
  setProjectForecast,
  setProjectStatus,
  toggleProjectGate,
  updateProjectDetail,
} from "@/lib/hq/actions/projects";
import { fmtDate, fmtWhen, isStale } from "@/lib/hq/format";
import type { Classifiers, Project, Settings } from "@/lib/hq/types";

type PartnerOption = { id: string; name: string };
type EventOption = { id: string; name: string };

type ProjectPatch =
  | { kind: "status"; id: string; slug: string }
  | { kind: "forecast"; id: string; slug: string }
  | { kind: "gate"; id: string; gateId: string; done: boolean }
  | { kind: "partner"; id: string; partnerId: string | null; partnerName: string };

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
  const [editingId, setEditingId] = useState<string | null>(null);
  // Mirrors the design's instance-level draft map: drafts survive re-renders
  // and expand/collapse, and are only cleared where the design clears them.
  const drafts = useRef<Record<string, string | undefined>>({});
  const noteInputRef = useRef<HTMLInputElement | null>(null);
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
    field: "name" | "leadName" | "leadContact" | "members" | "eventSrc",
    value: string,
  ) => {
    startTransition(async () => {
      await updateProjectDetail(projectId, { field, value });
    });
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
              placeholder="tg or email"
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
                const editing = editingId === p.id;
                const status = statusBySlug.get(p.statusSlug);
                const source = srcOf(p) || "Direct";
                return (
                  <Fragment key={p.id}>
                    <div
                      onClick={() => setExpandedId(expanded ? null : p.id)}
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
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "baseline",
                                marginBottom: 8,
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
                              <button
                                onClick={() => setEditingId(editing ? null : p.id)}
                                style={{
                                  border: "none",
                                  cursor: "pointer",
                                  background: "none",
                                  color: editing ? "var(--accent)" : "var(--label-3)",
                                  fontSize: 12,
                                  fontWeight: 600,
                                  padding: 0,
                                }}
                              >
                                {editing ? "Done" : "Edit"}
                              </button>
                            </div>
                            {editing ? (
                              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                <input
                                  defaultValue={p.name}
                                  onBlur={(e) => {
                                    if (e.target.value.trim())
                                      saveDetail(p.id, "name", e.target.value.trim());
                                  }}
                                  placeholder="Project name"
                                  style={{
                                    boxSizing: "border-box",
                                    padding: "7px 9px",
                                    border: "1px solid var(--sep)",
                                    borderRadius: 0,
                                    background: "var(--card)",
                                    color: "var(--label-1)",
                                    fontSize: 13,
                                    minWidth: 0,
                                  }}
                                />
                                <div style={{ display: "flex", gap: 6 }}>
                                  <input
                                    defaultValue={p.leadName}
                                    onBlur={(e) => saveDetail(p.id, "leadName", e.target.value)}
                                    placeholder="Lead"
                                    style={{
                                      flex: 1,
                                      boxSizing: "border-box",
                                      padding: "7px 9px",
                                      border: "1px solid var(--sep)",
                                      borderRadius: 0,
                                      background: "var(--card)",
                                      color: "var(--label-1)",
                                      fontSize: 13,
                                      minWidth: 0,
                                    }}
                                  />
                                  <input
                                    defaultValue={p.leadContact}
                                    onBlur={(e) => saveDetail(p.id, "leadContact", e.target.value)}
                                    placeholder="Contact"
                                    style={{
                                      flex: 1,
                                      boxSizing: "border-box",
                                      padding: "7px 9px",
                                      border: "1px solid var(--sep)",
                                      borderRadius: 0,
                                      background: "var(--card)",
                                      color: "var(--label-1)",
                                      fontSize: 13,
                                      minWidth: 0,
                                    }}
                                  />
                                </div>
                                <input
                                  defaultValue={p.members.join(", ")}
                                  onBlur={(e) => saveDetail(p.id, "members", e.target.value)}
                                  placeholder="Team, comma separated"
                                  style={{
                                    boxSizing: "border-box",
                                    padding: "7px 9px",
                                    border: "1px solid var(--sep)",
                                    borderRadius: 0,
                                    background: "var(--card)",
                                    color: "var(--label-1)",
                                    fontSize: 13,
                                    minWidth: 0,
                                  }}
                                />
                                <div style={{ display: "flex", gap: 6 }}>
                                  <select
                                    value={p.partnerId ?? ""}
                                    onChange={(e) => pickPartner(p.id, e.target.value)}
                                    style={{
                                      flex: 1,
                                      minWidth: 0,
                                      padding: "7px 9px",
                                      border: "1px solid var(--sep)",
                                      borderRadius: 0,
                                      background: "var(--card)",
                                      color: "var(--label-1)",
                                      fontSize: 13,
                                    }}
                                  >
                                    <option value="">No partner</option>
                                    {partnerOptions.map((o) => (
                                      <option key={o.id} value={o.id}>
                                        {o.name}
                                      </option>
                                    ))}
                                  </select>
                                  <select
                                    defaultValue={p.eventSrc}
                                    onChange={(e) =>
                                      saveDetail(p.id, "eventSrc", e.target.value)
                                    }
                                    style={{
                                      flex: 1,
                                      boxSizing: "border-box",
                                      padding: "7px 9px",
                                      border: "1px solid var(--sep)",
                                      borderRadius: 0,
                                      background: "var(--card)",
                                      color: "var(--label-1)",
                                      fontSize: 13,
                                      minWidth: 0,
                                    }}
                                  >
                                    <option value="">No source event</option>
                                    {eventOptionsFor(p.eventSrc).map((o) => (
                                      <option key={o.id} value={o.name}>
                                        {o.name}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </div>
                            ) : (
                              <div style={{ fontSize: 14, lineHeight: "22px" }}>
                                <div>
                                  <span style={{ color: "var(--label-3)" }}>Lead:</span>{" "}
                                  {p.leadName}{" "}
                                  <span
                                    style={{
                                      color: "var(--label-2)",
                                      fontFamily: "var(--mono)",
                                      fontSize: 12,
                                    }}
                                  >
                                    {p.leadContact}
                                  </span>
                                </div>
                                <div>
                                  <span style={{ color: "var(--label-3)" }}>Team:</span>{" "}
                                  <span style={{ color: "var(--label-2)" }}>
                                    {p.members.join(", ")}
                                  </span>
                                </div>
                                <div>
                                  <span style={{ color: "var(--label-3)" }}>Source:</span>{" "}
                                  <span style={{ color: "var(--label-2)" }}>{source}</span>
                                </div>
                              </div>
                            )}
                            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                              <select
                                value={p.statusSlug}
                                onChange={(e) => pickStatus(p.id, e.target.value, false)}
                                style={{
                                  padding: "6px 10px",
                                  border: "1px solid var(--sep)",
                                  borderRadius: 0,
                                  background: "var(--card)",
                                  color: "var(--label-1)",
                                  fontSize: 13,
                                }}
                              >
                                {classifiers.statuses.map((s) => (
                                  <option key={s.id} value={s.slug}>
                                    {s.label}
                                  </option>
                                ))}
                              </select>
                              <select
                                value={uiForecast(p.forecastSlug)}
                                onChange={(e) => pickForecast(p.id, slugForecast(e.target.value))}
                                style={{
                                  padding: "6px 10px",
                                  border: "1px solid var(--sep)",
                                  borderRadius: 0,
                                  background: "var(--card)",
                                  color: "var(--label-1)",
                                  fontSize: 13,
                                }}
                              >
                                {classifiers.forecasts.map((f) => (
                                  <option key={f.id} value={uiForecast(f.slug)}>
                                    {f.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                              <input
                                onChange={(e) => {
                                  drafts.current["blk" + p.id] = e.target.value;
                                }}
                                defaultValue={p.blocker}
                                placeholder="Current blocker"
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
                              <button
                                onClick={() => {
                                  const draft = drafts.current["blk" + p.id];
                                  const value = draft !== undefined ? draft : p.blocker;
                                  startTransition(async () => {
                                    await saveProjectBlocker(p.id, value);
                                  });
                                }}
                                style={accentBtn}
                              >
                                Save
                              </button>
                            </div>
                            <div style={{ fontSize: 12, color: "var(--label-3)", marginTop: 12 }}>
                              Last touched by {p.touchedBy}
                              {p.touchedAt ? `, ${fmtDate(p.touchedAt)}` : ""}
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
                            {p.notes.map((n) => (
                              <div
                                key={n.id}
                                style={{ padding: "6px 0", borderBottom: "1px solid var(--sep)" }}
                              >
                                <div style={{ fontSize: 12, color: "var(--label-3)" }}>
                                  {fmtWhen(n.createdAt, settings.timezone)}, {n.author}
                                </div>
                                <div style={{ fontSize: 13, marginTop: 2 }}>{n.body}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </Fragment>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
