import type { Classifiers } from "./types";

/**
 * The eight classifier tables are small, ordered, and read by nearly every HQ
 * page. The Neon driver speaks HTTP, so each statement is its own request:
 * aggregating them server-side turns eight round trips into one. `sort` orders
 * each aggregate and is then dropped from the payload.
 *
 * Kept out of queries.ts (which is "server-only") so tests can run the real
 * statement against a real Postgres instead of a copy that can drift.
 */
const CLASSIFIER_LISTS: Array<{ key: string; columns: string; table: string }> = [
  { key: "channels", columns: "id, label", table: "hq_partner_channels" },
  { key: "event_types", columns: "id, label, supports_end_date", table: "hq_event_types" },
  {
    key: "roles",
    columns: "id, label, filter_label, color, bg, is_judge",
    table: "hq_people_roles",
  },
  { key: "stages", columns: "id, slug, label, drop_color", table: "hq_partner_stages" },
  {
    key: "statuses",
    columns: "id, slug, label, color, counts_as_active",
    table: "hq_project_statuses",
  },
  { key: "forecasts", columns: "id, slug, label, color", table: "hq_project_forecasts" },
  { key: "gates", columns: "id, label", table: "hq_submission_gates" },
  { key: "exchange_items", columns: "id, slug, label", table: "hq_exchange_items" },
];

export const CLASSIFIERS_SELECT = `SELECT ${CLASSIFIER_LISTS.map(
  ({ key, columns, table }) =>
    `(SELECT COALESCE(jsonb_agg(to_jsonb(t) - 'sort' ORDER BY t.sort), '[]'::jsonb)
      FROM (SELECT ${columns}, sort FROM ${table}) t) AS ${key}`,
).join(",\n  ")}`;

type JsonRow = Record<string, unknown>;

const text = (value: unknown): string => (value == null ? "" : String(value));

/** Maps one CLASSIFIERS_SELECT row into the shape every screen consumes. */
export function toClassifiers(row: Record<string, unknown>): Classifiers {
  const list = (key: string): JsonRow[] => (row[key] as JsonRow[] | null) ?? [];
  return {
    channels: list("channels").map((r) => ({ id: text(r.id), label: text(r.label) })),
    eventTypes: list("event_types").map((r) => ({
      id: text(r.id),
      label: text(r.label),
      supportsEndDate: Boolean(r.supports_end_date),
    })),
    roles: list("roles").map((r) => ({
      id: text(r.id),
      label: text(r.label),
      filterLabel: text(r.filter_label),
      color: text(r.color),
      bg: text(r.bg),
      isJudge: Boolean(r.is_judge),
    })),
    stages: list("stages").map((r) => ({
      id: text(r.id),
      slug: text(r.slug),
      label: text(r.label),
      dropColor: text(r.drop_color),
    })),
    statuses: list("statuses").map((r) => ({
      id: text(r.id),
      slug: text(r.slug),
      label: text(r.label),
      color: text(r.color),
      countsAsActive: Boolean(r.counts_as_active),
    })),
    forecasts: list("forecasts").map((r) => ({
      id: text(r.id),
      slug: text(r.slug),
      label: text(r.label),
      color: text(r.color),
    })),
    gates: list("gates").map((r) => ({ id: text(r.id), label: text(r.label) })),
    exchangeItems: list("exchange_items").map((r) => ({
      id: text(r.id),
      slug: text(r.slug),
      label: text(r.label),
    })),
  };
}
