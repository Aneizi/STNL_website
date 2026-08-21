"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { startTransition, useEffect, useOptimistic, useState } from "react";
import { card, cardTitle, pageTitle } from "@/components/hq/ui";
import { useConfirmDelete } from "@/components/hq/ui-client";
import {
  addAward,
  addFinalist,
  addScore,
  clearScores,
  removeAward,
  removeFinalist,
  setAwardWinner,
} from "@/lib/hq/actions/demo";
import { fmtMoney } from "@/lib/hq/format";
import type {
  Award,
  DemoProject,
  FinalistProject,
  Judge,
  Score,
} from "@/lib/hq/types";

type FinalistPatch =
  | { type: "add"; item: FinalistProject }
  | { type: "remove"; projectId: string };
type AwardPatch =
  | { type: "add"; item: Award }
  | { type: "remove"; id: string }
  | { type: "winner"; id: string; projectId: string | null };
type ScorePatch = { type: "add"; item: Score } | { type: "clear"; projectId: string };

const strongInput: CSSProperties = {
  padding: "11px 12px",
  border: "1px solid var(--label-1)",
  borderRadius: 0,
  background: "transparent",
  color: "var(--label-1)",
  fontSize: 15,
  fontWeight: 500,
};

const pickerButton: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  width: "100%",
  textAlign: "left",
  cursor: "pointer",
  padding: "7px 10px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "transparent",
  fontSize: 13,
};

const pickerOption: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  cursor: "pointer",
  border: "none",
  padding: "7px 12px",
  fontSize: 13,
  color: "var(--label-1)",
};

const modalField: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--label-2)",
  position: "relative",
};

const scoreInput: CSSProperties = {
  flex: 1,
  minWidth: 0,
  boxSizing: "border-box",
  padding: "7px 10px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "transparent",
  color: "var(--label-1)",
  fontSize: 13,
};

export function DemoDay({
  projects,
  finalists: finalistsProp,
  awards: awardsProp,
  scores: scoresProp,
  judges,
  gatesTotal,
  finalistCap,
  verifiedOnlyFinalists,
}: {
  projects: DemoProject[];
  finalists: FinalistProject[];
  awards: Award[];
  scores: Score[];
  judges: Judge[];
  gatesTotal: number;
  finalistCap: number;
  verifiedOnlyFinalists: boolean;
}) {
  const [finalists, mutateFinalists] = useOptimistic(
    finalistsProp,
    (state: FinalistProject[], patch: FinalistPatch) =>
      patch.type === "add"
        ? [...state, patch.item]
        : state.filter((f) => f.projectId !== patch.projectId),
  );
  const [awards, mutateAwards] = useOptimistic(
    awardsProp,
    (state: Award[], patch: AwardPatch) => {
      if (patch.type === "add") return [...state, patch.item];
      if (patch.type === "remove") return state.filter((a) => a.id !== patch.id);
      return state.map((a) =>
        a.id === patch.id ? { ...a, winnerProjectId: patch.projectId } : a,
      );
    },
  );
  const [scores, mutateScores] = useOptimistic(
    scoresProp,
    (state: Score[], patch: ScorePatch) =>
      patch.type === "add"
        ? [
            // mirror the server upsert: a judge re-scoring replaces their entry
            ...state.filter(
              (s) =>
                !(s.judgeId === patch.item.judgeId && s.projectId === patch.item.projectId),
            ),
            patch.item,
          ]
        : state.filter((s) => s.projectId !== patch.projectId),
  );

  const armed = useConfirmDelete();
  const [draftFinalist, setDraftFinalist] = useState("");
  const [awardName, setAwardName] = useState("");
  const [awardAmount, setAwardAmount] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [judgeSel, setJudgeSel] = useState("");
  const [projectSel, setProjectSel] = useState("");
  const [scoreError, setScoreError] = useState<string | null>(null);
  // The cap and eligibility rules live in the server action, so a rejected
  // add has to say why — the optimistic row reverts on its own.
  const [finalistError, setFinalistError] = useState<string | null>(null);
  const [awardError, setAwardError] = useState<string | null>(null);

  const finalistIds = new Set(finalists.map((f) => f.projectId));
  const isVerified = (p: DemoProject) => p.gatesDone === gatesTotal;
  const eligible = projects
    .filter((p) => !finalistIds.has(p.id) && (!verifiedOnlyFinalists || isVerified(p)))
    .map((p) => ({ id: p.id, name: p.name + (isVerified(p) ? " (verified)" : "") }));
  const finalistOptions = finalists.map((f) => ({ id: f.projectId, name: f.name }));
  const countColor =
    finalists.length > 0 && finalists.length <= finalistCap
      ? "var(--green)"
      : "var(--label-3)";

  const byProject = new Map<string, Score[]>();
  for (const s of scores) {
    const list = byProject.get(s.projectId);
    if (list) list.push(s);
    else byProject.set(s.projectId, [s]);
  }
  const results = [...byProject.entries()]
    .map(([pid, ss]) => {
      const p = projects.find((x) => x.id === pid);
      return {
        pid,
        name: p ? p.name : "?",
        count: ss.length,
        avg: ss.reduce((t, s) => t + s.score, 0) / ss.length,
      };
    })
    .sort((a, b) => b.avg - a.avg);

  const awardsTotal = awards.reduce((s, a) => s + (+a.amount || 0), 0);

  const onAddFinalist = () => {
    const id = draftFinalist;
    if (!id || finalistIds.has(id)) return;
    if (finalists.length >= finalistCap) {
      setFinalistError(`Finalist cap reached (${finalistCap}).`);
      return;
    }
    const p = projects.find((x) => x.id === id);
    if (!p) return;
    setDraftFinalist("");
    setFinalistError(null);
    startTransition(async () => {
      mutateFinalists({
        type: "add",
        item: {
          projectId: p.id,
          position: finalists.length + 1,
          name: p.name,
          source: [p.partnerName, p.eventSrc].filter(Boolean).join(", "),
          gatesDone: p.gatesDone,
          gatesTotal,
        },
      });
      const res = await addFinalist(id);
      if (!res.ok) setFinalistError(res.error ?? "Could not add that finalist.");
    });
  };

  const onRemoveFinalist = (projectId: string) => {
    setFinalistError(null);
    startTransition(async () => {
      mutateFinalists({ type: "remove", projectId });
      const res = await removeFinalist(projectId);
      if (!res.ok) setFinalistError("Could not remove that finalist.");
    });
  };

  const onAddAward = () => {
    if (!awardName) return;
    const name = awardName;
    const amount = +(awardAmount || 0);
    setAwardName("");
    setAwardAmount("");
    startTransition(async () => {
      mutateAwards({
        type: "add",
        item: { id: `new-${Date.now()}`, name, sponsor: "", amount, winnerProjectId: null },
      });
      await addAward({ name, amount });
    });
  };

  const onRemoveAward = (awardId: string) => {
    startTransition(async () => {
      mutateAwards({ type: "remove", id: awardId });
      await removeAward(awardId);
    });
  };

  const onWinner = (awardId: string, value: string) => {
    setAwardError(null);
    startTransition(async () => {
      mutateAwards({ type: "winner", id: awardId, projectId: value || null });
      const res = await setAwardWinner(awardId, value || null);
      if (!res.ok) setAwardError(res.error ?? "Could not set that winner.");
    });
  };

  const onClearScores = (projectId: string) => {
    startTransition(async () => {
      mutateScores({ type: "clear", projectId });
      await clearScores(projectId);
    });
  };

  const openModal = () => {
    setScoreError(null);
    setModalOpen(true);
  };
  const closeModal = () => {
    setModalOpen(false);
    setScoreError(null);
  };

  const submitScore = (scoreDraft: string, noteDraft: string) => {
    if (!judgeSel || !projectSel || !scoreDraft) {
      setScoreError("Judge, finalist, and a score are required.");
      return;
    }
    if (+scoreDraft > 10 || +scoreDraft < 1) {
      setScoreError("Score must be between 1 and 10.");
      return;
    }
    if (!Number.isInteger(+scoreDraft)) {
      setScoreError("Score must be a whole number between 1 and 10.");
      return;
    }
    const judgeId = judgeSel;
    const projectId = projectSel;
    const score = +scoreDraft;
    const note = noteDraft || "";
    setScoreError(null);
    setModalOpen(false);
    startTransition(async () => {
      mutateScores({
        type: "add",
        item: { id: `new-${Date.now()}`, judgeId, projectId, score, note },
      });
      const res = await addScore({ judgeId, projectId, score, note });
      if (!res.ok) {
        // The action re-validates (real judge/finalist); surface its message
        // by reopening the modal the design closed optimistically. Selections
        // are only cleared on success so a retry keeps them.
        setScoreError(res.error ?? "Judge, finalist, and a score are required.");
        setModalOpen(true);
        return;
      }
      setJudgeSel("");
      setProjectSel("");
    });
  };

  return (
    <div>
      <Link href="/hq/projects" style={{ color: "var(--accent)", fontSize: 14, padding: 0 }}>
        &#8249; Projects
      </Link>
      <h1 style={{ ...pageTitle, margin: "8px 0 0" }}>Demo day</h1>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
          marginTop: 16,
          alignItems: "flex-start",
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 280,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div style={card}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <div style={cardTitle}>Finalists</div>
              <span
                style={{
                  fontSize: 13,
                  color: countColor,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {finalists.length} of {finalistCap}
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <select
                value={draftFinalist}
                onChange={(e) => setDraftFinalist(e.target.value)}
                style={{ ...strongInput, flex: 1, minWidth: 0 }}
              >
                <option value="">Pick a project to add</option>
                {eligible.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <button
                onClick={onAddFinalist}
                style={{
                  border: "none",
                  cursor: "pointer",
                  padding: "11px 18px",
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
            {finalistError ? (
              <div style={{ fontSize: 12, color: "var(--red)", marginTop: 8 }}>
                {finalistError}
              </div>
            ) : null}
            {finalists.map((f) => {
              const del = armed(`finalist-${f.projectId}`, "Remove", () =>
                onRemoveFinalist(f.projectId),
              );
              return (
                <div
                  key={f.projectId}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 0",
                    borderBottom: "1px solid var(--sep)",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{f.name}</div>
                    <div style={{ fontSize: 12, color: "var(--label-3)" }}>{f.source}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color:
                          f.gatesDone === f.gatesTotal ? "var(--green)" : "var(--orange)",
                      }}
                    >
                      {f.gatesDone === f.gatesTotal
                        ? "Verified"
                        : `${f.gatesDone}/${f.gatesTotal} gates`}
                    </span>
                    <button
                      className="hq-hover-accent"
                      onClick={del.onClick}
                      title={del.title}
                      style={{
                        border: "none",
                        cursor: "pointer",
                        background: "none",
                        color: del.color,
                        fontSize: 12,
                        fontWeight: del.fontWeight,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {del.label}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={card}>
            <div style={cardTitle}>Awards</div>
            <div style={{ fontSize: 13, color: "var(--label-2)", marginTop: 2 }}>
              {awards.length} categories
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input
                value={awardName}
                onChange={(e) => setAwardName(e.target.value)}
                placeholder="New award"
                style={{ ...strongInput, flex: 1, minWidth: 0 }}
              />
              <input
                type="number"
                min={0}
                value={awardAmount}
                onChange={(e) => setAwardAmount(e.target.value)}
                placeholder="$"
                style={{ ...strongInput, width: 86, flex: "none", boxSizing: "border-box" }}
              />
              <button
                onClick={onAddAward}
                style={{
                  border: "none",
                  cursor: "pointer",
                  padding: "11px 18px",
                  fontSize: 14,
                  fontWeight: 600,
                  background: "var(--label-1)",
                  color: "var(--bg)",
                }}
              >
                Add
              </button>
            </div>
            {awardError ? (
              <div style={{ fontSize: 12, color: "var(--red)", marginTop: 8 }}>{awardError}</div>
            ) : null}
            <div style={{ marginTop: 4 }}>
              {awards.map((a) => {
                const del = armed(`award-${a.id}`, "×", () => onRemoveAward(a.id));
                return (
                  <div
                    key={a.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      padding: "6px 0",
                      borderBottom: "1px solid var(--sep)",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14 }}>{a.name}</div>
                      <div style={{ fontSize: 11, color: "var(--label-3)" }}>
                        {[a.sponsor, a.amount ? fmtMoney(a.amount) : ""]
                          .filter(Boolean)
                          .join(", ")}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}>
                      <select
                        value={a.winnerProjectId ?? ""}
                        onChange={(e) => onWinner(a.id, e.target.value)}
                        style={{
                          padding: "5px 8px",
                          border: "1px solid var(--sep)",
                          borderRadius: 0,
                          background: "transparent",
                          color: "var(--label-1)",
                          fontSize: 12,
                          maxWidth: 140,
                        }}
                      >
                        <option value="">Undecided</option>
                        {finalistOptions.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="hq-hover-accent"
                        onClick={del.onClick}
                        title={del.title}
                        style={{
                          border: "none",
                          cursor: "pointer",
                          background: "none",
                          color: del.color,
                          fontSize: 12,
                          fontWeight: del.fontWeight,
                          lineHeight: 1,
                          padding: 2,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {del.label}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ paddingTop: 10 }}>
              <div style={{ fontSize: 14 }}>Total</div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--label-3)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {fmtMoney(awardsTotal)}
              </div>
            </div>
          </div>
        </div>
        <div
          style={{
            flex: 2,
            minWidth: 320,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {modalOpen ? (
            <ScoreModal
              judges={judges}
              finalists={finalistOptions}
              judgeSel={judgeSel}
              projectSel={projectSel}
              error={scoreError}
              onPickJudge={setJudgeSel}
              onPickFinalist={setProjectSel}
              onSubmit={submitScore}
              onClose={closeModal}
            />
          ) : null}
          <div style={{ background: "var(--label-1)", color: "var(--bg)", padding: "18px 20px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={cardTitle}>Results</div>
              <button
                onClick={openModal}
                style={{
                  border: "none",
                  cursor: "pointer",
                  padding: "7px 14px",
                  fontSize: 12,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  background: "var(--accent)",
                  color: "#fbf7f0",
                }}
              >
                Enter scores
              </button>
            </div>
            {results.length > 0 ? (
              // The last track is 52px so the delete's armed "Sure?" label
              // is never clipped (at 24px it was unreadable).
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "26px 1fr 80px 80px 52px",
                  gap: 8,
                  marginTop: 14,
                  padding: "10px 0 6px",
                  borderBottom: "1px solid rgba(251,247,240,0.2)",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "rgba(251,247,240,0.55)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                <span>#</span>
                <span>Project</span>
                <span>Scores</span>
                <span>Average</span>
                <span />
              </div>
            ) : null}
            {results.map((r, i) => {
              const del = armed(`score-${r.pid}`, "×", () => onClearScores(r.pid));
              return (
                <div
                  key={r.pid}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "26px 1fr 80px 80px 52px",
                    gap: 8,
                    padding: "9px 0",
                    borderBottom: "1px solid rgba(251,247,240,0.14)",
                    fontSize: 13,
                    alignItems: "baseline",
                  }}
                >
                  <span
                    style={{
                      color: "rgba(251,247,240,0.5)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {i + 1}
                  </span>
                  <span style={{ fontWeight: 600 }}>{r.name}</span>
                  <span
                    style={{
                      color: "rgba(251,247,240,0.5)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {r.count}x
                  </span>
                  <span
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                      color: "var(--accent)",
                    }}
                  >
                    {r.avg.toFixed(1)}
                  </span>
                  {/* This card is inverted, so the hook's label-3 rest colour
                      is swapped for the card's own muted cream. */}
                  <button
                    onClick={del.onClick}
                    title={del.title}
                    style={{
                      border: "none",
                      cursor: "pointer",
                      background: "none",
                      color: del.armed ? "var(--accent)" : "rgba(251,247,240,0.45)",
                      fontSize: 12,
                      fontWeight: del.fontWeight,
                      lineHeight: 1,
                      padding: 0,
                      textAlign: "right",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {del.label}
                  </button>
                </div>
              );
            })}
            {results.length === 0 ? (
              <div style={{ fontSize: 13, color: "rgba(251,247,240,0.55)", marginTop: 8 }}>
                No scores entered yet.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ScoreModal({
  judges,
  finalists,
  judgeSel,
  projectSel,
  error,
  onPickJudge,
  onPickFinalist,
  onSubmit,
  onClose,
}: {
  judges: Judge[];
  finalists: Array<{ id: string; name: string }>;
  judgeSel: string;
  projectSel: string;
  error: string | null;
  onPickJudge: (id: string) => void;
  onPickFinalist: (id: string) => void;
  onSubmit: (score: string, note: string) => void;
  onClose: () => void;
}) {
  const [judgeOpen, setJudgeOpen] = useState(false);
  const [finalistOpen, setFinalistOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [score, setScore] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectedJudge = judges.find((j) => j.id === judgeSel);
  const selectedFinalist = finalists.find((o) => o.id === projectSel);
  const matches = finalists.filter((o) =>
    o.name.toLowerCase().includes(query.toLowerCase()),
  );

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
          width: 400,
          maxWidth: "100%",
          boxSizing: "border-box",
          background: "var(--card)",
          boxShadow: "var(--shadow-pop)",
          padding: "20px 22px",
          transformOrigin: "top center",
        }}
      >
        <div style={{ fontFamily: "var(--serif)", fontSize: 24, fontWeight: 400 }}>
          Enter judge scores
        </div>
        <div style={{ fontSize: 13, color: "var(--label-2)", marginTop: 2 }}>
          2 minute pitch plus Q&amp;A, one score from 1 to 10
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          <div style={modalField}>
            Judge
            <button
              onClick={() => {
                setJudgeOpen((o) => !o);
                setFinalistOpen(false);
              }}
              style={{
                ...pickerButton,
                color: selectedJudge ? "var(--label-1)" : "var(--faded)",
              }}
            >
              <span>{selectedJudge ? selectedJudge.name : "Select a judge"}</span>
              <span style={{ color: "var(--label-3)", fontSize: 10 }}>{"▼"}</span>
            </button>
            {judgeOpen ? (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: 0,
                  right: 0,
                  zIndex: 5,
                  background: "var(--card)",
                  border: "1px solid var(--label-3)",
                  boxShadow: "var(--shadow-pop)",
                  maxHeight: 180,
                  overflowY: "auto",
                  padding: "4px 0",
                }}
              >
                {judges.map((judge) => (
                  <button
                    key={judge.id}
                    className="hq-hover-fill"
                    onClick={() => {
                      onPickJudge(judge.id);
                      setJudgeOpen(false);
                    }}
                    style={{
                      ...pickerOption,
                      fontWeight: judgeSel === judge.id ? 600 : 400,
                      ...(judgeSel === judge.id
                        ? { background: "var(--accent-fill)" }
                        : null),
                    }}
                  >
                    {judge.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div style={modalField}>
            Finalist
            <button
              onClick={() => {
                setFinalistOpen((o) => !o);
                setJudgeOpen(false);
                setQuery("");
              }}
              style={{
                ...pickerButton,
                color: selectedFinalist ? "var(--label-1)" : "var(--faded)",
              }}
            >
              <span>{selectedFinalist ? selectedFinalist.name : "Select a finalist"}</span>
              <span style={{ color: "var(--label-3)", fontSize: 10 }}>{"▼"}</span>
            </button>
            {finalistOpen ? (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: 0,
                  right: 0,
                  zIndex: 5,
                  background: "var(--card)",
                  border: "1px solid var(--label-3)",
                  boxShadow: "var(--shadow-pop)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "9px 12px 8px",
                    borderBottom: "1px solid var(--sep)",
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--label-3)",
                      flex: "none",
                    }}
                  >
                    Search
                  </span>
                  <input
                    autoFocus
                    placeholder="Type a name"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      boxSizing: "border-box",
                      padding: 0,
                      border: "none",
                      outline: "none",
                      background: "transparent",
                      color: "var(--label-1)",
                      fontSize: 13,
                    }}
                  />
                </div>
                <div style={{ position: "relative" }}>
                  <div style={{ maxHeight: 180, overflowY: "auto", padding: "4px 0" }}>
                    {matches.map((o) => (
                      <button
                        key={o.id}
                        className="hq-hover-fill"
                        onClick={() => {
                          onPickFinalist(o.id);
                          setFinalistOpen(false);
                        }}
                        style={{
                          ...pickerOption,
                          fontWeight: projectSel === o.id ? 600 : 400,
                          ...(projectSel === o.id
                            ? { background: "var(--accent-fill)" }
                            : null),
                        }}
                      >
                        {o.name}
                      </button>
                    ))}
                    {matches.length === 0 ? (
                      <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--label-3)" }}>
                        No finalists match.
                      </div>
                    ) : null}
                  </div>
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      height: 10,
                      pointerEvents: "none",
                      background: "linear-gradient(var(--card),rgba(255,255,255,0))",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: 12,
                      pointerEvents: "none",
                      background: "linear-gradient(rgba(255,255,255,0),var(--card))",
                    }}
                  />
                </div>
              </div>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="number"
              min={1}
              max={10}
              placeholder="Score"
              value={score}
              onChange={(e) => setScore(e.target.value)}
              style={scoreInput}
            />
            <input
              placeholder="Note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={scoreInput}
            />
          </div>
          {error ? <div style={{ fontSize: 12, color: "var(--red)" }}>{error}</div> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button
              onClick={onClose}
              style={{
                flex: 1,
                border: "1px solid var(--sep)",
                cursor: "pointer",
                padding: 9,
                background: "none",
                fontSize: 14,
                fontWeight: 600,
                color: "var(--label-2)",
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => onSubmit(score, note)}
              style={{
                flex: 1,
                border: "none",
                cursor: "pointer",
                padding: 9,
                fontSize: 14,
                fontWeight: 600,
                background: "var(--label-1)",
                color: "var(--bg)",
              }}
            >
              Save score
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
