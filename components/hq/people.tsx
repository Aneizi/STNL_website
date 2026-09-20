"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useState, useTransition } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { showToast } from "@/components/hq/toast";
import { FormField, card, input, pageTitle, primaryBtn } from "@/components/hq/ui";
import { correctPersonMatch, createPerson, deletePerson, setPersonCaptain, updatePerson } from "@/lib/hq/actions/people";
import type { Person, Role } from "@/lib/hq/types";

// Name, Tags, Contact and a chevron; a row expands in place to its editor
// (name, role, notes), the linked account and the Captain control. The rows
// draw no rule lines: only the header keeps its underline.
const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1.3fr) minmax(0,1.4fr) 40px",
  gap: 16,
};

const caption: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--label-3)",
};

const tagStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: 13,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  padding: "4px 9px",
  borderRadius: 2,
  whiteSpace: "nowrap",
};

const fieldLabel: CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };

/** The expanded panel's controls sit on the tinted panel, so they get the card background. */
const panelField: CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  height: 44,
  padding: "8px 12px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "var(--card)",
  color: "var(--label-1)",
  fontSize: 17,
};

const textBtn: CSSProperties = {
  alignSelf: "flex-start",
  border: "none",
  cursor: "pointer",
  background: "none",
  padding: 0,
};

const alertLine: CSSProperties = { margin: 0, fontSize: 16, color: "var(--red)" };

type FieldEdit =
  | { field: "name"; value: string }
  | { field: "roleId"; value: string }
  | { field: "notes"; value: string };

type OptimisticAction =
  | { type: "add"; person: Person }
  | { type: "update"; id: string; edit: FieldEdit };

type Drafts = { name: string; roleId: string; telegram: string; email: string };

const emptyDrafts = (roles: Role[]): Drafts => ({ name: "", roleId: roles[0]?.id ?? "", telegram: "", email: "" });

/** The card's tags: its role in the role's colours, then a Captain tag for an active grant. */
function Tags({ person, role }: { person: Person; role: Role | undefined }) {
  return (
    <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      {person.tags.map((tag) =>
        tag.kind === "capability" ? (
          <span key={`capability-${tag.label}`} style={{ ...tagStyle, color: "var(--accent-deep)", background: "var(--accent-fill)" }}>
            {tag.label}
          </span>
        ) : role ? (
          <span key="role" style={{ ...tagStyle, color: `var(--${role.color})`, background: `var(--${role.bg})` }}>
            {tag.label}
          </span>
        ) : null,
      )}
    </span>
  );
}

/**
 * One person: the summary row and, when expanded, the editor below it. The
 * row is a button for the keyboard too (Enter or Space toggles it); the
 * panel's controls are the row's siblings, so their keys never reach it.
 */
export function PersonRow({
  person,
  roles,
  expanded,
  matchCleared,
  onToggle,
  onEdit,
  onMatchCleared,
  onDeleted,
}: {
  person: Person;
  roles: Role[];
  expanded: boolean;
  /** The account link was cleared from this card in this session, so the control stays away (see People). */
  matchCleared: boolean;
  onToggle: () => void;
  /** Applies the optimistic edit; the row then saves it. */
  onEdit: (edit: FieldEdit) => void;
  onMatchCleared: () => void;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const [saving, startTransition] = useTransition();
  const [captainPending, startCaptainTransition] = useTransition();
  const pending = saving || captainPending;
  const [error, setError] = useState("");
  const role = roles.find((r) => r.id === person.roleId) ?? roles[0];
  const linked = person.builderUserId !== null;
  const telegram = person.account?.telegramUsername ? `@${person.account.telegramUsername}` : "";
  const email = person.account?.email ?? "";
  const accountLine = linked
    ? telegram
      ? `Logs in with Telegram ${telegram}`
      : email
        ? `Logs in with ${email}`
        : "Linked account"
    : person.contact
      ? `${person.contact}. No HQ account yet.`
      : "No contact, no HQ account.";
  const captainHint = !linked
    ? "No HQ account yet."
    : person.captain
      ? "Can be assigned to projects."
      : "Grants project access once assigned.";

  const saveField = (edit: FieldEdit) => {
    startTransition(async () => {
      setError("");
      onEdit(edit);
      const result = await updatePerson(person.id, edit);
      if (!result.ok) setError(result.error ?? "Could not save this change.");
    });
  };

  // Grants or removes Captain on the linked account. Removing it clears the
  // account's current project assignments in the same transaction, so that
  // is confirmed first. The fresh row (tag, button and hint) arrives with
  // the action's revalidation.
  const toggleCaptain = () => {
    if (!linked || pending) return;
    const next = !person.captain;
    if (!next && !window.confirm(`Remove Captain from ${person.name}? Their current project assignments are cleared.`)) return;
    setError("");
    startCaptainTransition(async () => {
      try {
        const result = await setPersonCaptain(person.id, next);
        if (result.ok) router.refresh();
        else setError(result.error ?? "Could not change Captain access.");
      } catch {
        setError("Could not change Captain access. Try again.");
      }
    });
  };

  // Clears a wrong provisional match: the account is detached from this
  // person and gets a person of its own. Roles, tags and grants are untouched.
  const flagWrongMatch = () => {
    const personId = person.personId;
    if (!personId || matchCleared || pending) return;
    const reason = window.prompt("Why is this account the wrong match? The link is cleared and the account keeps a card of its own.");
    if (reason === null) return;
    startTransition(async () => {
      setError("");
      const result = await correctPersonMatch({ personId, toUserId: null, reason });
      if (result.ok) {
        onMatchCleared();
        showToast("Match cleared");
        router.refresh();
      } else setError(result.error ?? "Could not clear the match.");
    });
  };

  // Deletes the card, and the CRM person behind it when this was that
  // person's last card. The HQ account, if there is one, is never deleted.
  const remove = () => {
    if (pending) return;
    if (!window.confirm(`Delete ${person.name} from People?${linked ? " Their HQ account is kept." : ""} This cannot be undone.`)) return;
    startTransition(async () => {
      setError("");
      const result = await deletePerson({ personId: person.id, confirmed: true });
      if (result.ok) {
        showToast("Person deleted");
        onDeleted();
        router.refresh();
      } else setError(result.error ?? "Could not delete this person.");
    });
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle();
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        className="hq-row-hover"
        onClick={onToggle}
        onKeyDown={onRowKeyDown}
        style={{
          ...grid,
          padding: "16px 20px",
          fontSize: 17,
          alignItems: "center",
          cursor: "pointer",
          // Set only while open: an inline background on a closed row would
          // also override the class's hover fill.
          ...(expanded ? { background: "var(--fill-4)" } : {}),
        }}
      >
        <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>{person.name}</span>
        <Tags person={person} role={role} />
        <span
          style={{
            color: "var(--label-2)",
            fontFamily: "var(--mono)",
            fontSize: 15,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {person.contact}
        </span>
        <span
          aria-hidden="true"
          style={{
            justifySelf: "end",
            color: "var(--label-3)",
            fontSize: 14,
            transform: `rotate(${expanded ? 180 : 0}deg)`,
            transition: "transform 160ms ease",
          }}
        >
          ▼
        </span>
      </div>
      {expanded ? (
        <div className="hq-fade-in" aria-busy={pending} style={{ padding: "24px 20px 28px", background: "var(--fill-4)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(300px,100%), 1fr))", gap: 32 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <label style={fieldLabel}>
                <span style={caption}>Name</span>
                <input
                  defaultValue={person.name}
                  onBlur={(e) => {
                    const trimmed = e.target.value.trim();
                    if (trimmed && trimmed !== person.name) saveField({ field: "name", value: trimmed });
                  }}
                  style={panelField}
                />
              </label>
              <label style={fieldLabel}>
                <span style={caption}>Role</span>
                <select
                  value={person.roleId}
                  onChange={(e) => saveField({ field: "roleId", value: e.target.value })}
                  style={panelField}
                >
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={fieldLabel}>
                <span style={caption}>Notes</span>
                <input
                  defaultValue={person.notes}
                  placeholder="None"
                  onBlur={(e) => {
                    if (e.target.value !== person.notes) saveField({ field: "notes", value: e.target.value });
                  }}
                  style={panelField}
                />
              </label>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={caption}>Account</span>
                <div style={{ fontSize: 17, lineHeight: 1.5 }}>{accountLine}</div>
                {telegram && email ? <div style={{ fontSize: 16, color: "var(--label-2)" }}>Also {email}</div> : null}
                {linked && person.personId && !matchCleared ? (
                  <button
                    type="button"
                    className="hq-hover-accent"
                    onClick={flagWrongMatch}
                    style={{ ...textBtn, color: "var(--label-3)", fontSize: 15, textDecoration: "underline", textUnderlineOffset: 3 }}
                  >
                    Wrong match?
                  </button>
                ) : null}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={caption}>Captain</span>
                <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={toggleCaptain}
                    disabled={!linked || pending}
                    aria-busy={captainPending}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                      border: "none",
                      cursor: "pointer",
                      height: 44,
                      padding: "0 18px",
                      borderRadius: 0,
                      fontSize: 17,
                      fontWeight: 600,
                      background: person.captain ? "transparent" : "var(--label-1)",
                      color: person.captain ? "var(--label-1)" : "var(--bg)",
                      boxShadow: person.captain ? "inset 0 0 0 1px var(--label-1)" : "none",
                      opacity: linked ? 1 : 0.5,
                    }}
                  >
                    {captainPending && <span className="hq-button-spinner" aria-hidden="true" />}
                    {captainPending
                      ? person.captain ? "Removing Captain…" : "Making Captain…"
                      : person.captain ? "Remove Captain" : "Make Captain"}
                  </button>
                  <span style={{ fontSize: 16, color: "var(--label-2)" }}>{captainHint}</span>
                </div>
              </div>
              {error ? (
                <p role="alert" style={alertLine}>
                  {error}
                </p>
              ) : null}
              <button
                type="button"
                onClick={remove}
                style={{ ...textBtn, marginTop: "auto", color: "var(--red)", fontSize: 15, fontWeight: 600 }}
              >
                Delete person
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function People({
  people: peopleProp,
  roles,
  reset,
}: {
  people: Person[];
  roles: Role[];
  reset: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [newOpen, setNewOpen] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>(() => emptyDrafts(roles));
  const [createError, setCreateError] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Cards whose account link was cleared in this session. The server then
  // hands the card a fresh person of its own, so without this the control
  // would come back and a second click would only churn that person.
  const [clearedMatches, setClearedMatches] = useState<Set<string>>(() => new Set());

  const [people, applyOptimistic] = useOptimistic(
    peopleProp,
    (state: Person[], action: OptimisticAction): Person[] => {
      if (action.type === "add") return [action.person, ...state];
      return state.map((p) => {
        if (p.id !== action.id) return p;
        const { edit } = action;
        if (edit.field === "roleId") {
          // Only the role tag follows a role edit; the Captain tag is a grant.
          const label = roles.find((r) => r.id === edit.value)?.label;
          return {
            ...p,
            roleId: edit.value,
            tags: p.tags.map((tag) => (tag.kind === "role" && label ? { ...tag, label } : tag)),
          };
        }
        return { ...p, [edit.field]: edit.value };
      });
    },
  );

  // ⌘K navigation contract: a ?reset=1 arrival clears the filter. State
  // adjusts during render (React's prop-change pattern); only the URL
  // cleanup lives in the effect.
  const [prevReset, setPrevReset] = useState(reset);
  if (reset !== prevReset) {
    setPrevReset(reset);
    if (reset) setRoleFilter("");
  }
  useEffect(() => {
    if (reset) router.replace("/hq/people");
  }, [reset, router]);

  // Opening and closing both start from empty drafts.
  const toggleNew = () => {
    setNewOpen((open) => !open);
    setDrafts(emptyDrafts(roles));
    setCreateError("");
  };

  const create = () => {
    if (pending) return;
    const name = drafts.name.trim();
    if (!name || !drafts.roleId) return;
    const telegram = drafts.telegram.trim();
    const email = drafts.email.trim();
    const person: Person = {
      id: `optimistic-${Date.now()}`,
      name,
      roleId: drafts.roleId,
      // The server keeps one contact, the handle first; shown the same way
      // until its own row arrives.
      contact: telegram ? `@${telegram.replace(/^@/, "")}` : email,
      notes: "",
      builderUserId: null,
      personId: null,
      account: null,
      captain: false,
      tags: [{ kind: "role", label: roles.find((r) => r.id === drafts.roleId)?.label ?? "", protected: false }],
      // An optimistic row has nothing attached to it yet; the server's own
      // counts replace this the moment the revalidation lands.
      removal: { cardId: "", name, hackathonId: 0, personId: null, hasAccount: false, rosterRows: 0, otherEditionCards: 0, judgeScores: 0, enrollments: 0 },
    };
    startTransition(async () => {
      setCreateError("");
      applyOptimistic({ type: "add", person });
      const result = await createPerson({ name, roleId: drafts.roleId, telegram, email });
      if (result.ok) {
        setNewOpen(false);
        setDrafts(emptyDrafts(roles));
      } else setCreateError(result.error ?? "Could not add this person.");
    });
  };

  const chips = [
    { id: "", label: "All" },
    ...roles.map((r) => ({ id: r.id, label: r.filterLabel })),
  ];

  const rows = people.filter((p) => !roleFilter || p.roleId === roleFilter);

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
          People <span style={{ fontWeight: 400, color: "var(--faded)" }}>{people.length}</span>
        </h1>
        <button type="button" onClick={toggleNew} style={primaryBtn}>
          New person
        </button>
      </div>
      {newOpen ? (
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
          <FormField label="Name" flex={1} minWidth={140}>
            <input value={drafts.name} onChange={(e) => setDrafts({ ...drafts, name: e.target.value })} style={input} />
          </FormField>
          <FormField label="Role" minWidth={110}>
            <select value={drafts.roleId} onChange={(e) => setDrafts({ ...drafts, roleId: e.target.value })} style={input}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label === "Other" ? "Other (specify in Notes)" : r.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Telegram" flex={1} minWidth={140}>
            <input
              value={drafts.telegram}
              onChange={(e) => setDrafts({ ...drafts, telegram: e.target.value })}
              placeholder="@handle"
              style={input}
            />
          </FormField>
          <FormField label="Email" flex={1} minWidth={140}>
            <input type="email" value={drafts.email} onChange={(e) => setDrafts({ ...drafts, email: e.target.value })} style={input} />
          </FormField>
          <button
            type="button"
            onClick={create}
            style={{
              border: "none",
              cursor: "pointer",
              boxSizing: "border-box",
              height: 44,
              padding: "0 16px",
              borderRadius: 0,
              fontSize: 17,
              fontWeight: 600,
              background: "var(--label-1)",
              color: "var(--bg)",
            }}
          >
            Add
          </button>
          {createError ? (
            <p role="alert" style={{ ...alertLine, width: "100%" }}>
              {createError}
            </p>
          ) : null}
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          gap: 6,
          marginTop: 28,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {chips.map((chip) => {
          const selected = roleFilter === chip.id;
          return (
            <button
              key={chip.id || "all"}
              type="button"
              aria-pressed={selected}
              onClick={() => setRoleFilter(chip.id)}
              style={{
                border: "none",
                cursor: "pointer",
                padding: "5px 12px",
                borderRadius: 2,
                fontSize: 14,
                background: selected ? "var(--accent-fill)" : "var(--fill-3)",
                color: selected ? "var(--accent-deep)" : "var(--label-2)",
                fontWeight: selected ? 600 : 400,
              }}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
      <div
        style={{
          background: "var(--card)",
          borderRadius: 0,
          boxShadow: "var(--shadow-1)",
          marginTop: 28,
          overflowX: "auto",
        }}
      >
        <div style={{ minWidth: 560 }}>
          <div style={{ ...grid, padding: "12px 20px", borderBottom: "1px solid var(--sep)", ...caption }}>
            <span>Name</span>
            <span>Tags</span>
            <span>Contact</span>
            <span />
          </div>
          {rows.map((p) => (
            <PersonRow
              key={p.id}
              person={p}
              roles={roles}
              expanded={expandedId === p.id}
              matchCleared={clearedMatches.has(p.id)}
              onToggle={() => setExpandedId((open) => (open === p.id ? null : p.id))}
              onEdit={(edit) => applyOptimistic({ type: "update", id: p.id, edit })}
              onMatchCleared={() => setClearedMatches((prev) => new Set(prev).add(p.id))}
              onDeleted={() => setExpandedId(null)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
