/**
 * Luma has no notion of an event type, so a newly mirrored event gets one
 * guessed from its title. Applied once, on first insert only — a re-sync never
 * revisits it, because type is HQ-owned the moment the row exists.
 *
 * Pure and DB-free so it can be tested without a database.
 */

export type EventTypeChoice = { id: string; label: string };

/** Title keyword → the hq_event_types label it implies. First match wins. */
const KEYWORD_RULES: Array<[keyword: string, label: string]> = [
  ["co-working", "Weekly coworking"],
  ["coworking", "Weekly coworking"],
  ["demo day", "Demo day"],
  ["workshop", "Workshop"],
  ["pitch", "Pitch session"],
  ["mixer", "Community mixer"],
];

const MULTI_DAY_LABEL = "Multi-day program";
const FALLBACK_LABEL = "Other";

function byLabel(types: EventTypeChoice[], label: string): EventTypeChoice | undefined {
  return types.find((t) => t.label.toLowerCase() === label.toLowerCase());
}

/**
 * Returns the id of the best-guess type, or null when the caller passed no
 * types at all. Falls back to "Other", then to whatever sorts first, so a
 * database with renamed types still yields a valid foreign key.
 */
export function guessEventTypeId(
  name: string,
  isMultiDay: boolean,
  types: EventTypeChoice[],
): string | null {
  if (types.length === 0) return null;

  if (isMultiDay) {
    const multiDay = byLabel(types, MULTI_DAY_LABEL);
    if (multiDay) return multiDay.id;
  }

  const title = name.toLowerCase();
  for (const [keyword, label] of KEYWORD_RULES) {
    if (!title.includes(keyword)) continue;
    const match = byLabel(types, label);
    if (match) return match.id;
  }

  return (byLabel(types, FALLBACK_LABEL) ?? types[0]).id;
}
