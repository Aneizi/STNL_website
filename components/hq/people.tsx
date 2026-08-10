"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import type { CSSProperties } from "react";
import { Badge, FormField, card, input, pageTitle, primaryBtn, smallSelect } from "@/components/hq/ui";
import { createPerson, updatePerson } from "@/lib/hq/actions/people";
import type { PartnerOption, Person, Role } from "@/lib/hq/types";

const grid: CSSProperties = {
  display: "grid",
  textAlign: "left",
  overflowWrap: "break-word",
  gridTemplateColumns:
    "minmax(0,1.4fr) 100px minmax(0,1.3fr) minmax(0,1.4fr) minmax(0,1.1fr) minmax(0,1.6fr) 40px",
  gap: 10,
};

const editField: CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  padding: "6px 8px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "var(--card)",
  color: "var(--label-1)",
  fontSize: 13,
};

const editSelect: CSSProperties = {
  width: "100%",
  minWidth: 0,
  padding: "6px 4px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "var(--card)",
  color: "var(--label-1)",
  fontSize: 12,
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

type Drafts = { name: string; roleId: string; org: string; contact: string; partnerId: string };

const emptyDrafts: Drafts = { name: "", roleId: "", org: "", contact: "", partnerId: "" };

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
    };
    startTransition(async () => {
      applyOptimistic({ type: "add", person });
      await createPerson({
        name: person.name,
        roleId,
        org: person.org,
        contact: person.contact,
        partnerId,
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
                  {r.label}
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
            <span>Role</span>
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
                  <span>
                    {role ? <Badge label={role.label} color={role.color} bg={role.bg} /> : null}
                  </span>
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
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
