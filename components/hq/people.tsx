"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import type { CSSProperties } from "react";
import { IconLockFill } from "symbols-react";
import { showToast } from "@/components/hq/toast";
import { Badge, FormField, card, input, pageTitle, primaryBtn, smallSelect } from "@/components/hq/ui";
import { correctPersonMatch, createPerson, deletePerson, updatePerson } from "@/lib/hq/actions/people";
import type { PartnerOption, Person, PersonTag, Role } from "@/lib/hq/types";

const grid: CSSProperties = {
  display: "grid",
  textAlign: "left",
  overflowWrap: "break-word",
  gridTemplateColumns:
    "minmax(0,1.4fr) 150px minmax(0,1.3fr) minmax(0,1.4fr) minmax(0,1.1fr) minmax(0,1.6fr) 40px",
  gap: 10,
};

const tagRow: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 };

const smallTextBtn: CSSProperties = {
  border: "none",
  cursor: "pointer",
  background: "none",
  color: "var(--label-3)",
  fontSize: 12,
  padding: 2,
  justifySelf: "start",
};

const CAPABILITY_HINT = "Granted in Admin";

/**
 * A capability tag: read-only, marked with a lock, never a role. It mirrors an
 * admin-granted account capability and the People editor cannot change it.
 */
function CapabilityTag({ tag }: { tag: PersonTag }) {
  return (
    <span
      title={CAPABILITY_HINT}
      aria-label={`${tag.label}, ${CAPABILITY_HINT.toLowerCase()}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        padding: "3px 8px",
        borderRadius: 2,
        color: "var(--label-2)",
        background: "var(--fill-3)",
        whiteSpace: "nowrap",
        cursor: "help",
      }}
    >
      <IconLockFill width={8} height={11.5} fill="currentColor" aria-hidden="true" style={{ display: "block" }} />
      {tag.label}
    </span>
  );
}

/** The card's tags: its role first, in the role's colours, then every locked capability tag. */
function Tags({ person, role }: { person: Person; role: Role | undefined }) {
  return (
    <span style={tagRow}>
      {person.tags.map((tag, index) =>
        tag.kind === "capability" ? (
          <CapabilityTag key={`${tag.kind}-${tag.label}`} tag={tag} />
        ) : role ? (
          <Badge key={`${tag.kind}-${index}`} label={tag.label} color={role.color} bg={role.bg} />
        ) : null,
      )}
    </span>
  );
}

const editField: CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  height: 32,
  padding: "6px 8px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "var(--card)",
  color: "var(--label-1)",
  fontSize: 13,
};

const editSelect: CSSProperties = {
  ...editField,
  padding: "6px 4px",
};

type FieldEdit =
  | { field: "name"; value: string }
  | { field: "roleId"; value: string }
  | { field: "org"; value: string }
  | { field: "contact"; value: string }
  | { field: "partnerId"; value: string | null }
  | { field: "notes"; value: string };

type OptimisticAction =
  | { type: "add"; person: Person }
  | { type: "update"; id: string; edit: FieldEdit };

type Drafts = {
  name: string;
  roleId: string;
  org: string;
  contact: string;
  partnerId: string;
};

const emptyDrafts: Drafts = {
  name: "",
  roleId: "",
  org: "",
  contact: "",
  partnerId: "",
};

export function People({
  people: peopleProp,
  partners,
  roles,
  reset,
}: {
  people: Person[];
  partners: PartnerOption[];
  roles: Role[];
  reset: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [newPersonOpen, setNewPersonOpen] = useState(false);
  const [roleFilter, setRoleFilter] = useState("");
  const [partnerFilter, setPartnerFilter] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  // Cards whose account link was cleared in this session. The server then
  // hands the card a fresh person of its own, so without this the button
  // would come back and a second click would only churn that person.
  const [clearedMatches, setClearedMatches] = useState<Set<string>>(() => new Set());
  const drafts = useRef<Drafts>({ ...emptyDrafts });

  const partnerNameOf = (id: string | null) =>
    id ? (partners.find((x) => x.id === id)?.name ?? "") : "";

  const [people, applyOptimistic] = useOptimistic(
    peopleProp,
    (state: Person[], action: OptimisticAction): Person[] => {
      if (action.type === "add") return [action.person, ...state];
      return state.map((p) => {
        if (p.id !== action.id) return p;
        const { edit } = action;
        if (edit.field === "partnerId") {
          return { ...p, partnerId: edit.value, partnerName: partnerNameOf(edit.value) };
        }
        if (edit.field === "roleId") {
          // Only the role tag follows a role edit; a capability tag is not editable here.
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

  // ⌘K navigation contract: a ?reset=1 arrival clears both filters.
  // State adjusts during render (React's prop-change pattern); only the
  // URL cleanup lives in the effect.
  const [prevReset, setPrevReset] = useState(reset);
  if (reset !== prevReset) {
    setPrevReset(reset);
    if (reset) {
      setRoleFilter("");
      setPartnerFilter("");
    }
  }
  useEffect(() => {
    if (reset) router.replace("/hq/people");
  }, [reset, router]);

  const saveField = (person: Person, edit: FieldEdit) => {
    startTransition(async () => {
      applyOptimistic({ type: "update", id: person.id, edit });
      await updatePerson(person.id, edit);
    });
  };

  // Clears a wrong provisional match: the account is detached from this
  // person and gets a person of its own. Roles, tags and grants are untouched.
  const flagWrongMatch = (person: Person) => {
    const personId = person.personId;
    if (!personId || clearedMatches.has(person.id)) return;
    const reason = window.prompt(
      "Why is this account the wrong match for this person? The link is cleared and the account keeps a card of its own.",
    );
    if (reason === null) return;
    setClearedMatches((prev) => new Set(prev).add(person.id));
    startTransition(async () => {
      const result = await correctPersonMatch({ personId, toUserId: null, reason });
      showToast(result.ok ? "Match cleared" : (result.error ?? "Could not clear the match"));
    });
  };

  /**
   * Deletes a People card, and the CRM person behind it when this is that
   * person's last card. The confirmation names the real counts the server
   * read with the row; the HQ account, if there is one, is never deleted.
   */
  const removePerson = (person: Person) => {
    const { removal } = person;
    const parts: string[] = [];
    if (removal.hasAccount) parts.push("their HQ account is KEPT; they lose their place in this hackathon");
    if (removal.enrollments) parts.push("their enrollment in this hackathon");
    if (removal.judgeScores) parts.push(`${removal.judgeScores} judge score${removal.judgeScores === 1 ? "" : "s"} they gave`);
    if (removal.otherEditionCards) parts.push(`their cards in ${removal.otherEditionCards} other hackathon${removal.otherEditionCards === 1 ? "" : "s"} are kept`);
    else if (removal.rosterRows) parts.push(`${removal.rosterRows} imported roster row${removal.rosterRows === 1 ? "" : "s"} stop pointing at them`);
    const detail = parts.length ? ` This also means: ${parts.join("; ")}.` : "";
    if (!window.confirm(`Delete ${person.name} from People?${detail} This cannot be undone.`)) return;
    startTransition(async () => {
      const result = await deletePerson({ personId: person.id, confirmed: true });
      showToast(result.ok ? "Person deleted" : (result.error ?? "Could not delete this person"));
      if (result.ok) { setEditingId(null); router.refresh(); }
    });
  };

  const create = () => {
    const d = drafts.current;
    if (!d.name) return;
    const roleId = d.roleId || roles[0]?.id;
    if (!roleId) return;
    const partnerId = d.partnerId || null;
    const person: Person = {
      id: `optimistic-${Date.now()}`,
      name: d.name,
      roleId,
      org: d.org,
      contact: d.contact,
      partnerId,
      partnerName: partnerNameOf(partnerId),
      notes: "",
      builderUserId: null,
      personId: null,
      tags: [{ kind: "role", label: roles.find((r) => r.id === roleId)?.label ?? "", protected: false }],
      // An optimistic row has nothing attached to it yet; the server's own
      // counts replace this the moment the revalidation lands.
      removal: { cardId: "", name: d.name, hackathonId: 0, personId: null, hasAccount: false, rosterRows: 0, otherEditionCards: 0, judgeScores: 0, enrollments: 0 },
    };
    startTransition(async () => {
      applyOptimistic({ type: "add", person });
      await createPerson({
        name: person.name,
        roleId,
        org: person.org,
        contact: person.contact,
        partnerId,
        notes: person.notes,
      });
    });
    drafts.current = { ...d, name: "", org: "", contact: "" };
    setNewPersonOpen(false);
  };

  const chips = [
    { id: "", label: "All" },
    ...roles.map((r) => ({ id: r.id, label: r.filterLabel })),
  ];

  const rows = people.filter(
    (p) =>
      (!roleFilter || p.roleId === roleFilter) &&
      (!partnerFilter || p.partnerId === partnerFilter),
  );

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
        <button
          onClick={() => {
            if (!newPersonOpen) drafts.current = { ...emptyDrafts };
            setNewPersonOpen(!newPersonOpen);
          }}
          style={primaryBtn}
        >
          New person
        </button>
      </div>
      {newPersonOpen ? (
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
          <FormField label="Name" flex={1} minWidth={140}>
            <input
              onChange={(e) => {
                drafts.current.name = e.target.value;
              }}
              style={input}
            />
          </FormField>
          <FormField label="Role" minWidth={110}>
            <select
              onChange={(e) => {
                drafts.current.roleId = e.target.value;
              }}
              style={input}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label === "Other" ? "Other (specify in Notes)" : r.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Organization" flex={1} minWidth={140}>
            <input
              onChange={(e) => {
                drafts.current.org = e.target.value;
              }}
              style={input}
            />
          </FormField>
          <FormField label="Contact" flex={1} minWidth={140}>
            <input
              onChange={(e) => {
                drafts.current.contact = e.target.value;
              }}
              style={input}
            />
          </FormField>
          <FormField label="Linked partner" minWidth={150}>
            <select
              onChange={(e) => {
                drafts.current.partnerId = e.target.value;
              }}
              style={input}
            >
              <option value="">None</option>
              {partners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </FormField>
          <button
            onClick={create}
            style={{
              border: "none",
              cursor: "pointer",
              boxSizing: "border-box",
              height: 36,
              padding: "0 16px",
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
      <div
        style={{
          display: "flex",
          gap: 6,
          marginTop: 14,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {chips.map((chip) => {
          const selected = roleFilter === chip.id;
          return (
            <button
              key={chip.id || "all"}
              onClick={() => setRoleFilter(chip.id)}
              style={{
                border: "none",
                cursor: "pointer",
                padding: "5px 12px",
                borderRadius: 2,
                fontSize: 12,
                background: selected ? "var(--accent-fill)" : "var(--fill-4)",
                color: selected ? "var(--accent-deep)" : "var(--label-2)",
                fontWeight: selected ? 600 : 400,
              }}
            >
              {chip.label}
            </button>
          );
        })}
        <select
          value={partnerFilter}
          onChange={(e) => setPartnerFilter(e.target.value)}
          style={smallSelect}
        >
          <option value="">All partners</option>
          {partners.map((o) => (
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
        <div style={{ minWidth: 720 }}>
          <div
            style={{
              ...grid,
              padding: "10px 16px",
              borderBottom: "1px solid var(--sep)",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--label-3)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            <span>Name</span>
            <span>Tags</span>
            <span>Organization</span>
            <span>Contact</span>
            <span>Partner</span>
            <span>Notes</span>
          </div>
          {rows.map((p) => {
            const role = roles.find((r) => r.id === p.roleId) ?? roles[0];
            if (editingId !== p.id) {
              return (
                <div
                  key={p.id}
                  style={{
                    ...grid,
                    padding: "11px 16px",
                    borderBottom: "1px solid var(--sep)",
                    fontSize: 14,
                    alignItems: "center",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{p.name}</span>
                  <Tags person={p} role={role} />
                  <span style={{ color: "var(--label-2)", fontSize: 13 }}>{p.org}</span>
                  <span
                    style={{
                      color: "var(--label-2)",
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {p.contact}
                  </span>
                  <span style={{ color: "var(--label-2)", fontSize: 13 }}>{p.partnerName}</span>
                  <span style={{ color: "var(--label-3)", fontSize: 13 }}>{p.notes}</span>
                  <button
                    className="hq-hover-accent"
                    onClick={() => setEditingId(p.id)}
                    style={{
                      border: "none",
                      cursor: "pointer",
                      background: "none",
                      color: "var(--label-3)",
                      fontSize: 12,
                      padding: 2,
                      justifySelf: "start",
                    }}
                  >
                    Edit
                  </button>
                </div>
              );
            }
            return (
              <div
                key={p.id}
                style={{
                  ...grid,
                  padding: "8px 16px",
                  borderBottom: "1px solid var(--sep)",
                  fontSize: 13,
                  alignItems: "center",
                  background: "var(--fill-4)",
                }}
              >
                <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  <input
                    defaultValue={p.name}
                    onBlur={(e) => {
                      const trimmed = e.target.value.trim();
                      if (trimmed && trimmed !== p.name) {
                        saveField(p, { field: "name", value: trimmed });
                      }
                    }}
                    style={editField}
                  />
                  {p.builderUserId && p.personId && !clearedMatches.has(p.id) ? (
                    <button
                      className="hq-hover-accent"
                      onClick={() => flagWrongMatch(p)}
                      title="This card is linked to an account. Clear the link if it is the wrong person."
                      style={smallTextBtn}
                    >
                      Wrong match?
                    </button>
                  ) : null}
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  <select
                    value={p.roleId}
                    onChange={(e) => saveField(p, { field: "roleId", value: e.target.value })}
                    style={editSelect}
                  >
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  {p.tags.some((tag) => tag.kind === "capability") ? (
                    <span style={{ ...tagRow, fontSize: 11, color: "var(--label-3)" }}>
                      {p.tags.filter((tag) => tag.kind === "capability").map((tag) => (
                        <CapabilityTag key={tag.label} tag={tag} />
                      ))}
                      {CAPABILITY_HINT}
                    </span>
                  ) : null}
                </span>
                <input
                  defaultValue={p.org}
                  onBlur={(e) => {
                    if (e.target.value !== p.org) {
                      saveField(p, { field: "org", value: e.target.value });
                    }
                  }}
                  style={editField}
                />
                <input
                  defaultValue={p.contact}
                  onBlur={(e) => {
                    if (e.target.value !== p.contact) {
                      saveField(p, { field: "contact", value: e.target.value });
                    }
                  }}
                  style={{ ...editField, fontFamily: "var(--mono)", fontSize: 12 }}
                />
                <select
                  value={p.partnerId ?? ""}
                  onChange={(e) =>
                    saveField(p, { field: "partnerId", value: e.target.value || null })
                  }
                  style={editSelect}
                >
                  <option value="">None</option>
                  {partners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
                <input
                  defaultValue={p.notes}
                  onBlur={(e) => {
                    if (e.target.value !== p.notes) {
                      saveField(p, { field: "notes", value: e.target.value });
                    }
                  }}
                  style={editField}
                />
                <span style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                  <button
                    onClick={() => setEditingId(null)}
                    style={{
                      border: "none",
                      cursor: "pointer",
                      background: "none",
                      color: "var(--accent)",
                      fontSize: 12,
                      fontWeight: 600,
                      padding: 2,
                      justifySelf: "start",
                    }}
                  >
                    Done
                  </button>
                  <button
                    onClick={() => removePerson(p)}
                    title="Delete this People card. The HQ account behind it, if any, is kept."
                    style={{ ...smallTextBtn, color: "var(--red)" }}
                  >
                    Delete
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
