/**
 * Attributes tracked projects to the events they came from.
 *
 * Each project counts once, at the first event (by the caller's ordering)
 * whose normalized name matches its event_src. Pure and DB-free so the
 * precedence rules below can be tested directly.
 */

import { normName } from "./format";

export type AttributableEvent = {
  id: string;
  name: string;
  archived: boolean;
};

export type AttributableProject = {
  event_src: string;
  counts_as_active: boolean;
  gates_done: number;
};

export type Outputs = { q: number; a: number; s: number };

/**
 * Active events claim a name first; archived ones only fill names no active
 * event answers to. So a live event always wins a collision with an archived
 * duplicate, while an archived event that is still the only match keeps the
 * projects attributed to it rather than silently dropping them.
 */
export function firstEventByName(events: AttributableEvent[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const archivedPass of [false, true]) {
    for (const e of events) {
      if (e.archived !== archivedPass) continue;
      const key = normName(e.name);
      if (!map.has(key)) map.set(key, e.id);
    }
  }
  return map;
}

export function attributeOutputs(
  events: AttributableEvent[],
  projects: AttributableProject[],
  gateTotal: number,
): Map<string, Outputs> {
  const byName = firstEventByName(events);
  const outputs = new Map<string, Outputs>();
  for (const p of projects) {
    const key = normName(p.event_src);
    if (!key) continue; // an unset source must never match a blank-named event
    const eventId = byName.get(key);
    if (!eventId) continue;
    const out = outputs.get(eventId) ?? { q: 0, a: 0, s: 0 };
    out.q += 1;
    if (p.counts_as_active) out.a += 1;
    if (gateTotal > 0 && p.gates_done === gateTotal) out.s += 1;
    outputs.set(eventId, out);
  }
  return outputs;
}
