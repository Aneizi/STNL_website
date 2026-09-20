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
  type CSSProperties,
} from "react";
import { IconBubbleAndPencil } from "@/components/hq/icons/IconBubbleAndPencil";
import { showToast } from "@/components/hq/toast";
import { FormField, input, pageTitle, primaryBtn } from "@/components/hq/ui";
import { CopyButton, useConfirmDelete, useSavedFlash } from "@/components/hq/ui-client";
import { updateBuilderProjectLead } from "@/lib/hq/actions/builders-admin";
import { assignProjectCaptain, unassignProjectCaptain } from "@/lib/hq/actions/captains";
import {
  addProjectMember,
  addProjectNote,
  createProject,
  deleteProject,
  editProjectNote,
  removeProjectMember,
  saveProjectBlocker,
  setProjectForecast,
  setProjectHighPotential,
  toggleProjectGate,
  updateProjectDetail,
  updateProjectMember,
} from "@/lib/hq/actions/projects";
import { PROJECT_STAGES } from "@/lib/hq/builder-types";
import { SUBMISSION_LABELS } from "@/lib/hq/colosseum-snapshot";
import { fmtDate, fmtWhen, isStale } from "@/lib/hq/format";
import type { ProjectReportingStatus } from "@/lib/hq/reporting";
import { SUBMISSION_FILTER_LABEL, statusLabel } from "@/lib/hq/reporting-view";
import type {
  Classifiers,
  NoteItem,
  Project,
  ProjectMember,
  Settings,
} from "@/lib/hq/types";
import { projectHref } from "./builder-admin";
import { BuilderProjectImage } from "./builder-project-image";
import { ProjectUpdates } from "./project-updates";
import styles from "./projects.module.css";

type CaptainOption = { id: string; name: string };
/** A roster row the service could not resolve either way, echoed back verbatim (by memberId) as the acknowledgement of the second "Assign anyway" call. */
type UnresolvedCaptainRosterRow = { memberId: string; name: string; username: string | null };
type CaptainReview = { projectId: string; captainUserId: string; captainName: string; unresolved: UnresolvedCaptainRosterRow[] };

type ProjectPatch =
  | { kind: "forecast"; id: string; slug: string }
  | { kind: "gate"; id: string; gateId: string; done: boolean }
  | { kind: "captain"; id: string; captainUserId: string | null; captainName: string }
  | { kind: "highPotential"; id: string; highPotential: boolean }
  | { kind: "lead"; id: string; leadName: string; leadUsername: string }
  | { kind: "memberAdd"; id: string; member: ProjectMember }
  | { kind: "memberRemove"; id: string; memberId: string }
  | { kind: "noteEdit"; id: string; noteId: string; body: string; editedAt: string }
  | { kind: "remove"; id: string };

function applyPatch(list: Project[], patch: ProjectPatch): Project[] {
  if (patch.kind === "remove") return list.filter((p) => p.id !== patch.id);
  return list.map((p) => {
    if (p.id !== patch.id) return p;
    switch (patch.kind) {
      case "forecast":
        return { ...p, forecastSlug: patch.slug };
      case "gate":
        return {
          ...p,
          gates: patch.done
            ? [...p.gates, patch.gateId]
            : p.gates.filter((g) => g !== patch.gateId),
        };
      case "captain":
        return { ...p, captainUserId: patch.captainUserId, captainName: patch.captainName };
      case "highPotential":
        return { ...p, highPotential: patch.highPotential };
      case "lead":
        return {
          ...p,
          leadName: patch.leadName,
          colosseum: p.colosseum ? { ...p.colosseum, leadUsername: patch.leadUsername } : p.colosseum,
        };
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

/** The heading over each of the expanded row's four blocks. */
const blockHeading: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "var(--label-3)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

/** Micro-label in the details panel's left column, the Colosseum block and the team modal. */
const microLabel: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--label-3)",
};

/** Shared field style for the details panel, the timeline and the team modal inputs. */
const panelField: CSSProperties = {
  width: "100%",
  minWidth: 0,
  minHeight: 44,
  boxSizing: "border-box",
  padding: "6px 8px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "var(--card)",
  color: "var(--label-1)",
  fontSize: 16,
};

/** Monospace contacts, kept at 16px so focusing them does not zoom a phone browser. */
const contactField: CSSProperties = {
  ...panelField,
  fontFamily: "var(--mono)",
  fontSize: 16,
};

/** The small accent button beside a field: Team Edit/Add, note Save. */
const smallAccentBtn: CSSProperties = {
  border: "none",
  cursor: "pointer",
  padding: "4px 9px",
  borderRadius: 0,
  fontSize: 14,
  fontWeight: 600,
  background: "var(--fill-2)",
  color: "var(--accent)",
};

/** One button of the filter bar's segmented controls. */
const segmentButton = (on: boolean): CSSProperties => ({
  border: "none",
  cursor: "pointer",
  padding: "5px 12px",
  borderRadius: 0,
  fontSize: 16,
  background: on ? "var(--label-1)" : "none",
  color: on ? "var(--bg)" : "var(--label-2)",
  fontWeight: on ? 600 : 400,
});

// Gates carries a bar and a count, so it gets the widest fixed track; Blocker
// is only a tick in this view (the text lives in the details panel), so it
// needs no more than the glyph. Weekly holds "Not updated" plus a missed
// count, so it needs a little more than Check-in. The last track is the
// action column, wide enough for the two-step delete's "Sure?".
const gridColumns = "minmax(0,2.4fr) minmax(0,1.3fr) 126px 211px 110px 125px 77px 55px";

/** The stage as the team's own settings name it; an unknown value shows as stored. */
const stageLabel = (stage: string): string => PROJECT_STAGES.find((s) => s.value === stage)?.label ?? stage;

/**
 * A project's logo on a soft fill, so the box reads at its full size while
 * the image loads and behind a transparent one. Covered, never letterboxed:
 * the board treats the logo as a photo.
 */
function ProjectImage({ src, name, size }: { src: string | null; name: string; size: number }) {
  return (
    <span style={{ display: "flex", width: size, height: size, flex: "none", background: "var(--fill-3)" }}>
      <BuilderProjectImage src={src} name={name} size={size} radius={0} fit="cover" />
    </span>
  );
}

/**
 * The detail panel's Captain control: a picker limited to accounts with an
 * active Captain grant, a "No Captain" removal option, and, only while
 * `review` names this exact project, the second, explicit confirmation step
 * an unresolved roster identity requires. A conflict is a plain toast
 * elsewhere (nothing changed, this select just snaps back to
 * `project.captainUserId` on the next render); unresolved identity is
 * instead this standing choice until the operator confirms or cancels it,
 * visible at the point of assignment, not folded into a toast that could be
 * missed.
 */
function CaptainField({
  id,
  project,
  captainOptions,
  review,
  onPick,
  onRemove,
  onAssignAnyway,
  onCancelReview,
}: {
  id: string;
  project: Project;
  captainOptions: CaptainOption[];
  review: CaptainReview | null;
  onPick: (captainUserId: string) => void;
  onRemove: () => void;
  onAssignAnyway: (unresolved: UnresolvedCaptainRosterRow[]) => void;
  onCancelReview: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <select
        id={id}
        value={project.captainUserId ?? ""}
        onChange={(e) => {
          const value = e.target.value;
          if (!value) onRemove();
          else onPick(value);
        }}
        style={panelField}
      >
        <option value="">No Captain</option>
        {captainOptions.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {review ? (
        <div
          style={{
            fontSize: 14,
            color: "var(--label-2)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "8px 10px",
            background: "var(--fill-4)",
          }}
        >
          <span>
            {review.unresolved.length} roster row{review.unresolved.length === 1 ? "" : "s"} on this project could not
            be checked against an imported HQ identity yet:{" "}
            {review.unresolved.map((m) => (m.username ? `@${m.username}` : m.name)).join(", ")}. Assign{" "}
            {review.captainName} anyway?
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" onClick={() => onAssignAnyway(review.unresolved)} style={smallAccentBtn}>
              Assign anyway
            </button>
            <button
              type="button"
              onClick={onCancelReview}
              className="hq-hover-accent"
              style={{ border: "none", cursor: "pointer", background: "none", color: "var(--label-3)", fontSize: 14, padding: "4px 9px" }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Projects({
  projects,
  captainOptions,
  reporting,
  classifiers,
  settings,
  now,
  expandId,
}: {
  projects: Project[];
  /** Accounts with an active Captain grant, resolved server side, never every account filtered on the client. */
  captainOptions: CaptainOption[];
  /**
   * Each project's weekly reporting state for this edition, from
   * `reportingStatus` (a fixed number of queries whatever the project count).
   * A project with no row here is simply not in weekly reporting, which is a
   * real state rather than a missing one.
   */
  reporting: ProjectReportingStatus[];
  classifiers: Classifiers;
  settings: Settings;
  now: number;
  expandId: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [optimistic, patch] = useOptimistic(projects, applyPatch);

  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projSearch, setProjSearch] = useState("");
  const [forecastFilter, setForecastFilter] = useState("");
  // The four reporting filters the plan names. Independent booleans, not one
  // select: "Keep those indicators independent and combinable", so an admin
  // can ask for an unassigned team that also missed a week.
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [notUpdatedOnly, setNotUpdatedOnly] = useState(false);
  const [missedOnly, setMissedOnly] = useState(false);
  const [notSubmittedOnly, setNotSubmittedOnly] = useState(false);
  // A deep link (?expand=) opens its row in the first render, server side
  // included; the effect below only handles a later change of the param.
  const [expandedId, setExpandedId] = useState<string | null>(expandId);
  const [teamModalFor, setTeamModalFor] = useState<string | null>(null);
  // One commit path: every panel control saves on change or blur, and this
  // flash beside the "Details" heading is the only confirmation.
  const { phase: savedPhase, flash } = useSavedFlash();
  const armedDelete = useConfirmDelete();
  // Mirrors the design's instance-level draft map: drafts survive re-renders
  // and expand/collapse, and are only cleared where the design clears them.
  const drafts = useRef<Record<string, string | undefined>>({});
  const noteInputRef = useRef<HTMLInputElement | null>(null);
  // The note being rewritten, and its working copy. One at a time: the
  // timeline is narrow, and an open editor replaces the note's own row.
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState("");
  const prevExpandId = useRef<string | null>(null);
  // The detail panel's Captain picker needs a second, explicit step when the
  // service reports unresolved roster identity: this holds that pending
  // choice (which project, which candidate, which exact roster rows were
  // shown) until the operator confirms or cancels it. Only one at a time,
  // the same reasoning as editingNoteId, and, like editingNoteId, cleared
  // whenever the expanded project changes, so a stale review never
  // reappears against a different (or the same, later) row on re-expand.
  const [captainReview, setCaptainReview] = useState<CaptainReview | null>(null);

  useEffect(() => {
    if (expandId && expandId !== prevExpandId.current) {
      setExpandedId(expandId);
      setCaptainReview(null);
      setProjSearch("");
      setForecastFilter("");
      setUnassignedOnly(false);
      setNotUpdatedOnly(false);
      setMissedOnly(false);
      setNotSubmittedOnly(false);
      router.replace("/hq/projects");
    }
    prevExpandId.current = expandId;
  }, [expandId, router]);

  const gatesTotal = classifiers.gates.length;
  const forecastBySlug = new Map(classifiers.forecasts.map((f) => [f.slug, f]));
  // The board's reporting rows, by project id. A project with no row is not
  // in weekly reporting; the column says so and the three weekly filters
  // leave it out rather than guessing a state for it.
  const reportingBy = new Map(reporting.map((row) => [row.projectId, row]));

  const pickForecast = (projectId: string, slug: string) => {
    startTransition(async () => {
      patch({ kind: "forecast", id: projectId, slug });
      await setProjectForecast(projectId, slug);
    });
  };

  // Captain assignment waits for the service result because the
  // service can refuse (a conflict) or ask for a second, explicit
  // confirmation (unresolved roster identity; captainReview holds that
  // pending state above). acknowledgedUnresolvedIds is only ever the
  // memberIds from a needs_review response already shown to the operator,
  // on that second, operator-driven call, never invented client-side.
  const pickCaptain = (projectId: string, captainUserId: string, acknowledgedUnresolvedIds?: string[]) => {
    const captainName = captainOptions.find((o) => o.id === captainUserId)?.name ?? "";
    startTransition(async () => {
      const result = await assignProjectCaptain({ projectId, captainUserId, acknowledgedUnresolvedIds });
      if (result.outcome === "assigned") {
        patch({ kind: "captain", id: projectId, captainUserId, captainName });
        setCaptainReview(null);
        flash();
      } else if (result.outcome === "needs_review") {
        // Always the service's own, freshly re-derived list: if the
        // operator's acknowledgement above was stale (something resolved,
        // or a new row appeared), this replaces it with what is current now.
        setCaptainReview({ projectId, captainUserId, captainName, unresolved: result.unresolved });
      } else {
        setCaptainReview(null);
        showToast(result.error);
      }
    });
  };

  const removeCaptain = (projectId: string) => {
    startTransition(async () => {
      const res = await unassignProjectCaptain(projectId);
      if (res.ok) {
        patch({ kind: "captain", id: projectId, captainUserId: null, captainName: "" });
        setCaptainReview((current) => (current?.projectId === projectId ? null : current));
        flash();
      } else {
        showToast(res.error ?? "Could not remove the Captain.");
      }
    });
  };

  const toggleHighPotential = (projectId: string, highPotential: boolean) => {
    startTransition(async () => {
      patch({ kind: "highPotential", id: projectId, highPotential });
      const res = await setProjectHighPotential(projectId, highPotential);
      if (!res.ok) showToast(res.error ?? "Could not save the high potential flag.");
    });
  };

  // An imported project's lead is one of its Colosseum roster rows; the
  // service rewrites the project's lead name from that row, so the patch
  // mirrors it with the roster name rather than trusting a typed one.
  const pickLead = (project: Project, username: string) => {
    const member = project.members.find((m) => m.username === username);
    startTransition(async () => {
      patch({ kind: "lead", id: project.id, leadName: member?.name ?? project.leadName, leadUsername: username });
      const res = await updateBuilderProjectLead(project.id, username);
      if (!res.ok) showToast(res.error ?? "Could not save the lead.");
    });
  };

  const toggleGate = (projectId: string, gateId: string, done: boolean) => {
    startTransition(async () => {
      patch({ kind: "gate", id: projectId, gateId, done });
      await toggleProjectGate(projectId, gateId, done);
    });
  };

  const saveDetail = (
    projectId: string,
    field: "leadName" | "leadContact",
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
        member: { id: `new-${Date.now()}`, name, contact, username: null },
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
      partnerId: null,
      eventSrc: "",
    };
    startTransition(async () => {
      await createProject(payload);
    });
    d.ProjName = d.ProjLead = d.ProjContact = "";
    setNewProjectOpen(false);
  };

  const onAddNote = (p: Project) => {
    const txt = (drafts.current["note" + p.id] ?? "").trim();
    if (!txt) return;
    startTransition(async () => {
      await addProjectNote(p.id, txt);
    });
    drafts.current["note" + p.id] = "";
    if (noteInputRef.current) noteInputRef.current.value = "";
  };

  const onDeleteProject = (projectId: string) => {
    if (expandedId === projectId) { setExpandedId(null); setCaptainReview(null); }
    startTransition(async () => {
      patch({ kind: "remove", id: projectId });
      const res = await deleteProject(projectId);
      if (!res.ok && res.error) showToast(res.error);
    });
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

  const toggleExpanded = (projectId: string) => {
    setExpandedId((current) => (current === projectId ? null : projectId));
    setEditingNoteId(null);
    setCaptainReview(null);
  };

  const teamProject = teamModalFor
    ? (optimistic.find((x) => x.id === teamModalFor) ?? null)
    : null;

  const q = projSearch.toLowerCase();
  const filtered = optimistic.filter((p) => {
    const weekly = reportingBy.get(p.id);
    return (!q || p.name.toLowerCase().includes(q) || p.leadName.toLowerCase().includes(q))
      && (!forecastFilter || p.forecastSlug === forecastFilter)
      && (!unassignedOnly || !p.captainUserId)
      // "Not updated this period" is about the week that is open now, so a
      // project outside the campaign window, paused, or not in reporting is
      // not one of them.
      && (!notUpdatedOnly || Boolean(weekly && !weekly.paused && weekly.current && !weekly.current.completed))
      && (!missedOnly || (weekly?.missedPeriods ?? 0) > 0)
      // Colosseum's own signal, kept separate from the weekly one: "Not
      // checked" is not "Not submitted", so only the confirmed reading
      // matches here.
      && (!notSubmittedOnly || weekly?.submissionStatus === "not_submitted");
  });

  return (
    <>
    <div className={styles.board} style={{ "--project-columns": gridColumns } as CSSProperties}>
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
        <button
          type="button"
          aria-expanded={newProjectOpen}
          onClick={() => setNewProjectOpen(!newProjectOpen)}
          style={primaryBtn}
        >
          New project
        </button>
      </div>

      {newProjectOpen ? (
        <div
          className="hq-fade-in"
          style={{
            background: "var(--card)",
            borderRadius: 0,
            boxShadow: "var(--shadow-1)",
            padding: 24,
            marginTop: 28,
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
          <button type="button" onClick={onCreateProject} style={{ ...primaryBtn, padding: "9px 16px" }}>
            Add
          </button>
        </div>
      ) : null}

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
              aria-label="Filter by name or lead"
              placeholder="Filter by name or lead"
              style={{
                padding: "8px 12px",
                border: "1px solid var(--sep)",
                borderRadius: 0,
                background: "transparent",
                color: "var(--label-1)",
                fontSize: 17,
                width: 190,
              }}
            />
            <select
              value={forecastFilter}
              onChange={(e) => setForecastFilter(e.target.value)}
              aria-label="Forecast"
              style={{
                padding: "7px 10px",
                border: "1px solid var(--sep)",
                borderRadius: 0,
                background: "transparent",
                color: "var(--label-1)",
                fontSize: 16,
              }}
            >
              <option value="">All forecasts</option>
              {classifiers.forecasts.map((f) => (
                <option key={f.id} value={f.slug}>
                  {f.label}
                </option>
              ))}
            </select>
            {/* Four independent toggles, so any combination is askable: an
                unassigned team that also missed a week is one click each. */}
            <div className={styles.filters} style={{ boxShadow: "0 0 0 1px var(--sep)", padding: 2 }}>
              {[
                { label: "Unassigned", on: unassignedOnly, set: setUnassignedOnly },
                { label: "Not updated", on: notUpdatedOnly, set: setNotUpdatedOnly },
                { label: "Missed weeks", on: missedOnly, set: setMissedOnly },
                { label: SUBMISSION_FILTER_LABEL, on: notSubmittedOnly, set: setNotSubmittedOnly },
              ].map((toggle) => (
                <button
                  key={toggle.label}
                  type="button"
                  aria-pressed={toggle.on}
                  onClick={() => toggle.set(!toggle.on)}
                  style={segmentButton(toggle.on)}
                >
                  {toggle.label}
                </button>
              ))}
            </div>
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
            <div className={styles.table}>
              <div
                className={styles.tableHeader}
                style={{
                  textAlign: "left",
                  overflowWrap: "break-word",
                  padding: "10px 16px",
                  borderBottom: "1px solid var(--sep)",
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--label-3)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                <span>Project</span>
                <span>Lead</span>
                <span>Forecast</span>
                <span>Gates</span>
                <span>Check-in</span>
                <span>Weekly</span>
                <span style={{ textAlign: "center" }}>Blocker</span>
                <span />
              </div>
              {filtered.map((p) => {
                const done = p.gates.length;
                const del = armedDelete(`project-${p.id}`, "×", () => onDeleteProject(p.id));
                const stale = isStale(p.lastCheckIn, settings.staleDays, now);
                const weekly = reportingBy.get(p.id) ?? null;
                const expanded = expandedId === p.id;
                const colosseumUrl = p.colosseum ? projectHref(p.colosseum.url) : undefined;
                // Imported rosters include the lead, who already has a dedicated
                // chip below. Match the username so namesakes stay on the team.
                const leadUsername = p.colosseum?.leadUsername.trim().toLowerCase();
                const teammates = p.members.filter((member) => !leadUsername || member.username?.trim().toLowerCase() !== leadUsername);
                // The roster rows a lead can be chosen from: those with a
                // Colosseum username. The stored lead stays offered even if
                // its row has since lost its username, so the select never
                // shows a value it has no option for.
                const leadOptions = p.colosseum
                  ? [
                      ...(p.colosseum.leadUsername && !p.members.some((m) => m.username === p.colosseum?.leadUsername)
                        ? [{ name: p.leadName, username: p.colosseum.leadUsername }]
                        : []),
                      ...p.members.flatMap((m) => (m.username ? [{ name: m.name, username: m.username }] : [])),
                    ]
                  : [];
                return (
                  <Fragment key={p.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={expanded}
                      aria-controls={`project-details-${p.id}`}
                      onClick={() => toggleExpanded(p.id)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleExpanded(p.id);
                        }
                      }}
                      className={`hq-row-hover ${styles.projectRow}`}
                      style={{
                        textAlign: "left",
                        overflowWrap: "break-word",
                        padding: "11px 16px",
                        fontSize: 17,
                        cursor: "pointer",
                        alignItems: "center",
                        background: expanded ? "var(--fill-4)" : undefined,
                      }}
                    >
                      {/* Logo, name, and a fixed slot for the HP badge, so
                          names line up whether or not a row carries one. */}
                      <span
                        className={styles.projectName}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "30px minmax(0,1fr) 36px",
                          alignItems: "center",
                          gap: 10,
                          minWidth: 0,
                        }}
                      >
                        <ProjectImage src={p.colosseum?.imageUrl ?? null} name={p.name} size={30} />
                        <span
                          style={{
                            fontWeight: 600,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {p.name}
                        </span>
                        {p.highPotential ? (
                          <span
                            title="High potential"
                            style={{
                              justifySelf: "start",
                              fontSize: 12,
                              fontWeight: 600,
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                              padding: "2px 6px",
                              background: "var(--accent-fill)",
                              color: "var(--accent-deep)",
                            }}
                          >
                            HP
                          </span>
                        ) : null}
                      </span>
                      <span data-label="Lead" style={{ color: "var(--label-2)" }}>{p.leadName}</span>
                      <span data-label="Forecast" style={{ fontSize: 16, color: "var(--label-2)" }}>
                        {forecastBySlug.get(p.forecastSlug)?.label ?? ""}
                      </span>
                      <span data-label="Gates">
                      <span style={{ display: "flex", alignItems: "center", gap: 10, paddingRight: 24 }}>
                        <span
                          style={{
                            flex: 1,
                            maxWidth: 120,
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
                            fontSize: 14,
                            color: "var(--label-2)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {done}/{gatesTotal}
                        </span>
                      </span>
                      </span>
                      <span
                        data-label="Check-in"
                        style={{
                          fontSize: 16,
                          color: stale ? "var(--red)" : "var(--label-2)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {fmtDate(p.lastCheckIn)}
                      </span>
                      {/* The week as HQ records it, with any earlier weeks
                          missed underneath. Colosseum's own submitted signal
                          stays out of this column: they are separate facts,
                          and the filters above keep them separate too. */}
                      <span data-label="Weekly" style={{ fontSize: 16, color: "var(--label-2)", lineHeight: 1.25 }}>
                        {weekly
                          ? <>
                              <span style={{ color: weekly.paused ? "var(--label-3)" : weekly.current?.completed ? "var(--green)" : "var(--label-1)" }}>
                                {weekly.paused ? "Paused" : weekly.current ? statusLabel(weekly.current.completed) : "No open week"}
                              </span>
                              {weekly.missedPeriods > 0 ? <><br /><span style={{ fontSize: 14, color: "var(--red)" }}>{weekly.missedPeriods} missed</span></> : null}
                            </>
                          : <span style={{ color: "var(--label-3)" }}>Not in reporting</span>}
                      </span>
                      {/* A blocker is a yes/no signal at this altitude; the
                          text itself is one row-click away, in the panel. */}
                      <span
                        className={styles.blockerCell}
                        data-label="Blocker"
                        title={p.blocker || undefined}
                        aria-label={p.blocker ? `Blocked: ${p.blocker}` : "No blocker"}
                        style={{ fontSize: 17, color: "var(--orange)", lineHeight: 1 }}
                      >
                        {p.blocker ? "✓" : <span className={styles.mobileOnly}>None</span>}
                      </span>
                      {/* The × is a glyph, not an icon: it carries a larger
                          type size than the armed "Sure?" it swaps with. */}
                      <button
                        type="button"
                        className={`hq-hover-accent ${styles.deleteProject}`}
                        onClick={del.onClick}
                        title={del.title}
                        aria-label={del.armed ? "Confirm delete" : `Delete ${p.name}`}
                        style={{
                          justifySelf: "end",
                          border: "none",
                          cursor: "pointer",
                          background: "none",
                          color: del.color,
                          fontSize: del.armed ? 12 : 18,
                          fontWeight: del.fontWeight,
                          lineHeight: 1,
                          padding: 2,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {del.label}
                      </button>
                      <span className={styles.mobileDisclosure} aria-hidden="true">{expanded ? "Hide details −" : "Show details +"}</span>
                    </div>
                    {expanded ? (
                      <div
                        id={`project-details-${p.id}`}
                        role="region"
                        aria-label={`${p.name} details`}
                        className={`hq-fade-in ${styles.expanded}`}
                        style={{
                          padding: "18px 16px",
                          background: "var(--fill-4)",
                        }}
                      >
                        <div className={styles.detailsGrid}>
                          <div>
                            <div style={{ ...blockHeading, marginBottom: 10 }}>Colosseum</div>
                            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                              <ProjectImage src={p.colosseum?.imageUrl ?? null} name={p.name} size={56} />
                              <p style={{ margin: 0, fontSize: 16, color: "var(--label-2)", lineHeight: 1.5 }}>
                                {p.colosseum?.description ?? ""}
                              </p>
                            </div>
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "auto minmax(0,1fr)",
                                columnGap: 12,
                                rowGap: 6,
                                marginTop: 12,
                                fontSize: 16,
                                alignItems: "baseline",
                              }}
                            >
                              <span style={microLabel}>Stage</span>
                              <span>{p.colosseum ? stageLabel(p.colosseum.stage) : "Unknown"}</span>
                              <span style={microLabel}>Category</span>
                              <span>{p.colosseum?.category || "Uncategorised"}</span>
                              <span style={microLabel}>Submission</span>
                              <span>{SUBMISSION_LABELS[p.colosseum?.submissionStatus ?? "not_checked"]}</span>
                            </div>
                            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
                              {colosseumUrl ? (
                                <a
                                  href={colosseumUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{
                                    fontSize: 16,
                                    fontWeight: 600,
                                    color: "var(--accent)",
                                    textDecoration: "underline",
                                    textUnderlineOffset: 3,
                                  }}
                                >
                                  View on Colosseum
                                </a>
                              ) : null}
                              <button
                                type="button"
                                aria-pressed={p.highPotential}
                                onClick={() => {
                                  toggleHighPotential(p.id, !p.highPotential);
                                  flash();
                                }}
                                style={{
                                  border: "none",
                                  cursor: "pointer",
                                  padding: "4px 9px",
                                  borderRadius: 0,
                                  fontSize: 14,
                                  fontWeight: 600,
                                  background: p.highPotential ? "var(--accent-fill)" : "var(--fill-3)",
                                  color: p.highPotential ? "var(--accent-deep)" : "var(--label-2)",
                                }}
                              >
                                {p.highPotential ? "High potential ✓" : "Mark high potential"}
                              </button>
                            </div>
                            <div style={{ fontSize: 14, color: "var(--label-3)", marginTop: 10 }}>
                              {p.colosseum
                                ? `Imported from Colosseum by ${p.colosseum.importedByName} on ${fmtDate(p.colosseum.importedAt)}.`
                                : `Created in HQ on ${fmtDate(p.createdAt)}. Not linked to a Colosseum project yet.`}
                            </div>
                          </div>
                          <div>
                            <div style={{ ...blockHeading, marginBottom: 10 }}>Submission gates</div>
                            {classifiers.gates.map((g) => {
                              const gateDone = p.gates.includes(g.id);
                              return (
                                <label
                                  key={g.id}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    padding: "6px 0",
                                    fontSize: 17,
                                    cursor: "pointer",
                                    color: gateDone ? "var(--label-1)" : "var(--label-2)",
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={gateDone}
                                    onChange={() => {
                                      toggleGate(p.id, g.id, !gateDone);
                                      flash();
                                    }}
                                    style={{
                                      accentColor: "var(--accent)",
                                      width: 15,
                                      height: 15,
                                      margin: 0,
                                    }}
                                  />
                                  <span>{g.label}</span>
                                </label>
                              );
                            })}
                          </div>
                          <div>
                            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
                              <span style={blockHeading}>Details</span>
                              {savedPhase !== "hidden" && (
                                <span
                                  style={{
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
                            </div>
                            <div className={styles.detailFields}>
                              <label htmlFor={`lead-${p.id}`} style={microLabel}>Lead</label>
                              {p.colosseum ? (
                                <select
                                  id={`lead-${p.id}`}
                                  value={p.colosseum.leadUsername}
                                  onChange={(e) => {
                                    pickLead(p, e.target.value);
                                    flash();
                                  }}
                                  style={panelField}
                                >
                                  {leadOptions.map((m) => (
                                    <option key={m.username} value={m.username}>
                                      {m.name} (@{m.username})
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  id={`lead-${p.id}`}
                                  defaultValue={p.leadName}
                                  onBlur={(e) => {
                                    if (e.target.value !== p.leadName) {
                                      saveDetail(p.id, "leadName", e.target.value);
                                      flash();
                                    }
                                  }}
                                  style={panelField}
                                />
                              )}
                              <label htmlFor={`contact-${p.id}`} style={microLabel}>Contact</label>
                              <div style={{ display: "flex", gap: 6, minWidth: 0, alignItems: "center" }}>
                                <input
                                  id={`contact-${p.id}`}
                                  defaultValue={p.leadContact}
                                  onBlur={(e) => {
                                    if (e.target.value !== p.leadContact) {
                                      saveDetail(p.id, "leadContact", e.target.value);
                                      flash();
                                    }
                                  }}
                                  placeholder="tg, x, or email"
                                  style={{ ...contactField, flex: 1, minWidth: 0 }}
                                />
                                <CopyButton value={p.leadContact} />
                              </div>
                              <span style={microLabel}>Team</span>
                              <div
                                style={{
                                  display: "flex",
                                  flexWrap: "wrap",
                                  gap: 8,
                                  alignItems: "center",
                                }}
                              >
                                {/* The lead is always on the team: first, always
                                    present, not removable. */}
                                <button
                                  type="button"
                                  className="hq-chip-lead"
                                  onClick={() => copyChip(p.leadName, p.leadContact)}
                                  title="Copy contact"
                                  style={{
                                    border: "none",
                                    cursor: "pointer",
                                    padding: "3px 8px",
                                    fontSize: 14,
                                    fontWeight: 600,
                                  }}
                                >
                                  {p.leadName}
                                </button>
                                {teammates.map((m) => (
                                  <button
                                    key={m.id}
                                    type="button"
                                    className="hq-chip-member"
                                    onClick={() => copyChip(m.name, m.contact)}
                                    title="Copy contact"
                                    style={{
                                      border: "none",
                                      cursor: "pointer",
                                      padding: "3px 8px",
                                      fontSize: 14,
                                    }}
                                  >
                                    {m.name}
                                  </button>
                                ))}
                                {/* An imported roster is Colosseum's to change,
                                    so the modal only opens on a project HQ
                                    keeps the roster of itself. */}
                                {p.colosseum ? null : (
                                  <button
                                    type="button"
                                    aria-haspopup="dialog"
                                    onClick={() => setTeamModalFor(p.id)}
                                    style={smallAccentBtn}
                                  >
                                    {p.members.length ? "Edit" : "Add"}
                                  </button>
                                )}
                              </div>
                              <label htmlFor={`captain-${p.id}`} style={microLabel}>Captain</label>
                              <CaptainField
                                id={`captain-${p.id}`}
                                project={p}
                                captainOptions={captainOptions}
                                review={captainReview && captainReview.projectId === p.id ? captainReview : null}
                                onPick={(captainUserId) => pickCaptain(p.id, captainUserId)}
                                onRemove={() => removeCaptain(p.id)}
                                onAssignAnyway={(unresolved) => {
                                  if (!captainReview) return;
                                  pickCaptain(p.id, captainReview.captainUserId, unresolved.map((m) => m.memberId));
                                }}
                                onCancelReview={() => setCaptainReview(null)}
                              />
                              <label htmlFor={`forecast-${p.id}`} style={microLabel}>Forecast</label>
                              <select
                                id={`forecast-${p.id}`}
                                value={p.forecastSlug}
                                onChange={(e) => {
                                  pickForecast(p.id, e.target.value);
                                  flash();
                                }}
                                style={panelField}
                              >
                                {classifiers.forecasts.map((f) => (
                                  <option key={f.id} value={f.slug}>
                                    {f.label}
                                  </option>
                                ))}
                              </select>
                              <label htmlFor={`blocker-${p.id}`} style={microLabel}>Blocker</label>
                              <input
                                id={`blocker-${p.id}`}
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
                            <div style={{ fontSize: 14, color: "var(--label-3)", marginTop: 12 }}>
                              Last touched by {p.touchedBy}
                              {p.touchedAt ? `, ${fmtDate(p.touchedAt)}` : ""}. Changes save as you go.
                            </div>
                          </div>
                          <div>
                            <ProjectUpdates key={p.id} projectId={p.id} timezone={settings.timezone} />
                            <div style={{ ...blockHeading, marginBottom: 10 }}>Timeline</div>
                            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                              <input
                                ref={noteInputRef}
                                onChange={(e) => {
                                  drafts.current["note" + p.id] = e.target.value;
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") onAddNote(p);
                                }}
                                aria-label="Add a note"
                                placeholder="Add a note"
                                style={{ ...panelField, flex: 1, minWidth: 0 }}
                              />
                              <button
                                type="button"
                                onClick={() => onAddNote(p)}
                                style={{
                                  border: "none",
                                  cursor: "pointer",
                                  padding: "7px 12px",
                                  borderRadius: 0,
                                  fontSize: 16,
                                  fontWeight: 600,
                                  background: "var(--fill-2)",
                                  color: "var(--accent)",
                                }}
                              >
                                Add
                              </button>
                            </div>
                            {p.notes.map((n) => {
                              const editing = editingNoteId === n.id;
                              return (
                                <div key={n.id} style={{ padding: "8px 0" }}>
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 8,
                                      fontSize: 14,
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
                                      type="button"
                                      className="hq-hover-accent"
                                      onClick={() =>
                                        editing ? setEditingNoteId(null) : onEditNote(n)
                                      }
                                      title="Edit note"
                                      aria-label={editing ? "Stop editing" : "Edit note"}
                                      aria-pressed={editing}
                                      style={{
                                        flex: "none",
                                        display: "inline-flex",
                                        border: "none",
                                        cursor: "pointer",
                                        background: "none",
                                        padding: "0 2px",
                                        color: editing ? "var(--accent)" : "var(--label-3)",
                                      }}
                                    >
                                      <IconBubbleAndPencil width={13} height={13} style={{ display: "block" }} />
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
                                        aria-label="Edit note"
                                        style={{ ...panelField, flex: 1, minWidth: 0 }}
                                      />
                                      <button
                                        type="button"
                                        onClick={() => onSaveNote(p.id, n)}
                                        style={{ ...smallAccentBtn, flex: "none" }}
                                      >
                                        Save
                                      </button>
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: 16, marginTop: 2 }}>{n.body}</div>
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
              from here rather than holding a permanent navbar tab. */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <Link
              href="/hq/demo"
              className="hq-ghost-btn"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "7px 12px",
                fontSize: 16,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Demo day →
            </Link>
          </div>
        </>
    </div>
      {teamProject ? (
        <TeamModal
          project={teamProject}
          onClose={() => setTeamModalFor(null)}
          onAdd={(name, contact) => onAddMember(teamProject.id, name, contact)}
          onUpdate={onUpdateMember}
          onRemove={(memberId) => onRemoveMember(teamProject.id, memberId)}
        />
      ) : null}
    </>
  );
}

/**
 * The team modal: one grid of name, contact and action for the header, every
 * teammate, and the add row. The lead is not on it: the lead is edited in the
 * details panel and is always on the team.
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
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("input, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)");
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
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
        background: "rgba(0,0,0,0.3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-modal-title"
        className={`hq-pop-in-modal ${styles.teamModal}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          maxWidth: "100%",
          boxSizing: "border-box",
          background: "var(--card)",
          boxShadow: "var(--shadow-pop)",
          padding: "20px 22px",
        }}
      >
        <div id="team-modal-title" style={{ fontFamily: "var(--serif)", fontSize: 28, fontWeight: 400 }}>
          {project.name} team
        </div>
        <div className={styles.teamGrid}>
          <span style={microLabel}>Name</span>
          <span style={microLabel}>Contact</span>
          <span />
          {project.members.map((m) => {
            const del = armed(`mem-${m.id}`, "×", () => onRemove(m.id));
            return (
              <Fragment key={m.id}>
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
                  style={contactField}
                />
                {/* Two-step like every delete in HQ: the × arms, "Sure?" performs. */}
                <button
                  type="button"
                  className="hq-hover-accent"
                  onClick={del.onClick}
                  title={del.armed ? del.title : "Remove"}
                  aria-label={del.armed ? "Confirm remove" : `Remove ${m.name}`}
                  style={{
                    border: "none",
                    cursor: "pointer",
                    background: "none",
                    color: del.color,
                    fontSize: del.armed ? 12 : 21,
                    fontWeight: del.fontWeight,
                    lineHeight: 1,
                    padding: 2,
                    whiteSpace: "nowrap",
                  }}
                >
                  {del.label}
                </button>
              </Fragment>
            );
          })}
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            aria-label="New teammate"
            placeholder="New teammate"
            style={panelField}
          />
          <input
            value={contactDraft}
            onChange={(e) => setContactDraft(e.target.value)}
            aria-label="New teammate contact"
            placeholder="tg, x, or email"
            style={contactField}
          />
          <button
            type="button"
            onClick={add}
            title="Add"
            aria-label="Add teammate"
            style={{
              border: "none",
              cursor: "pointer",
              background: "var(--fill-2)",
              color: "var(--accent)",
              fontSize: 17,
              fontWeight: 600,
              lineHeight: 1,
              padding: "5px 0",
            }}
          >
            +
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onClose} style={primaryBtn}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
