// Integration tests for the Luma mirror, run against a real Postgres (PGlite,
// the engine compiled to WASM) so upsert semantics, array predicates and the
// pinned/archived CASE expressions are genuinely exercised.
//
// Unlike tests/hq/database.test.ts, these do not copy the runtime SQL — they
// call buildSyncStatements() itself, so the statements under test cannot drift
// from the ones lib/hq/luma-sync.ts actually runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { buildSyncStatements, type SyncRow } from "@/lib/hq/luma-sync-sql";
import { applyUpgrades } from "@/scripts/hq/upgrades";

const SCHEMA = readFileSync(join(process.cwd(), "scripts/hq/schema.sql"), "utf8");

function statements(text: string): string[] {
  return text
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type Row = Record<string, unknown>;
type Lazy = { text: string; params: unknown[] };

/**
 * The tagged template lib/hq/db.ts's drivers expose, backed by PGlite. Builds
 * an unexecuted {text, params} so it can be handed to buildSyncStatements and
 * replayed inside a transaction, exactly as the real transaction() does.
 */
function tagged(strings: TemplateStringsArray, ...values: unknown[]): Lazy {
  return {
    text: strings.reduce(
      (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""),
      "",
    ),
    params: values,
  };
}

let pg: PGlite;

async function run(text: string, params: unknown[] = []): Promise<Row[]> {
  return (await pg.query(text, params)).rows as Row[];
}

/** Runs the built statements in one transaction, returning each one's rows. */
async function runSync(input: {
  rows: SyncRow[];
  ids?: string[];
  startedAt?: string;
  reconcile?: boolean;
}): Promise<Row[][]> {
  const rows = input.rows;
  const ids = input.ids ?? rows.map((r) => r.luma_id);
  const built = buildSyncStatements(tagged, {
    rows,
    ids,
    startedAt: input.startedAt ?? new Date().toISOString(),
    reconcile: input.reconcile ?? ids.length > 0,
  }) as Lazy[];

  const out: Row[][] = [];
  await pg.transaction(async (tx) => {
    for (const q of built) out.push((await tx.query(q.text, q.params)).rows as Row[]);
  });
  return out;
}

async function typeId(label: string): Promise<string> {
  const [row] = await run(`SELECT id FROM hq_event_types WHERE label = $1`, [label]);
  return String(row.id);
}

function row(over: Partial<SyncRow> & Pick<SyncRow, "luma_id" | "type_id">): SyncRow {
  return {
    luma_url: `https://luma.com/${over.luma_id}`,
    name: "Co-Working Friday",
    date: "2026-08-07",
    end_date: null,
    venue: "AI AM",
    cohost: "",
    guest_count: 0,
    ...over,
  } as SyncRow;
}

/** Dates come back as text, mirroring lib/hq/queries.ts, so no driver or
 *  timezone parsing can shift them out from under an assertion. */
async function event(lumaId: string): Promise<Row> {
  const [found] = await run(
    `SELECT *, date::text AS date, end_date::text AS end_date
     FROM hq_events WHERE luma_id = $1`,
    [lumaId],
  );
  return found;
}

beforeEach(async () => {
  pg = new PGlite();
  for (const statement of statements(SCHEMA)) await run(statement);
  await applyUpgrades({ query: (text) => run(text) as Promise<Record<string, unknown>[]> });
  await run(
    `INSERT INTO hq_event_types (label, supports_end_date, sort) VALUES
       ('Multi-day program', true, 0), ('Weekly coworking', false, 1),
       ('Workshop', false, 2), ('Demo day', false, 3), ('Other', false, 4)`,
  );
});

describe("luma sync", () => {
  it("inserts events from an empty database", async () => {
    const type = await typeId("Weekly coworking");
    await runSync({ rows: [row({ luma_id: "evt-a", type_id: type })] });

    const inserted = await event("evt-a");
    expect(inserted.name).toBe("Co-Working Friday");
    expect(inserted.venue).toBe("AI AM");
    expect(inserted.luma_url).toBe("https://luma.com/evt-a");
    expect(inserted.archived_at).toBeNull();
  });

  it("updates unpinned fields on re-sync but leaves pinned ones alone", async () => {
    const type = await typeId("Weekly coworking");
    await runSync({ rows: [row({ luma_id: "evt-a", type_id: type })] });
    await run(
      `UPDATE hq_events SET name = 'Renamed in HQ', pinned_fields = ARRAY['name']
       WHERE luma_id = 'evt-a'`,
    );

    await runSync({
      rows: [row({ luma_id: "evt-a", type_id: type, name: "Renamed in Luma", venue: "New venue" })],
    });

    const after = await event("evt-a");
    expect(after.name).toBe("Renamed in HQ"); // pinned
    expect(after.venue).toBe("New venue"); // not pinned
  });

  it("never overwrites HQ-owned fields on re-sync", async () => {
    const coworking = await typeId("Weekly coworking");
    const workshop = await typeId("Workshop");
    await runSync({ rows: [row({ luma_id: "evt-a", type_id: coworking })] });
    await run(
      `UPDATE hq_events SET attendance = 42, spend = 500, leads = 7 WHERE luma_id = 'evt-a'`,
    );

    // A later sync carries a different guessed type and a guest count.
    await runSync({
      rows: [row({ luma_id: "evt-a", type_id: workshop, guest_count: 99 })],
    });

    const after = await event("evt-a");
    expect(after.attendance).toBe(42);
    expect(after.spend).toBe(500);
    expect(after.leads).toBe(7);
    expect(after.type_id).toBe(coworking);
  });

  it("archives an event that vanishes from Luma, rather than deleting it", async () => {
    const type = await typeId("Weekly coworking");
    await runSync({
      rows: [row({ luma_id: "evt-a", type_id: type }), row({ luma_id: "evt-b", type_id: type })],
    });

    await runSync({ rows: [row({ luma_id: "evt-a", type_id: type })] });

    const gone = await event("evt-b");
    expect(gone).toBeDefined(); // still there
    expect(gone.archived_at).not.toBeNull();
    expect(gone.archived_reason).toBe("missing");
  });

  it("keeps a manually archived event archived while it is still in Luma", async () => {
    const type = await typeId("Weekly coworking");
    await runSync({ rows: [row({ luma_id: "evt-a", type_id: type })] });
    await run(
      `UPDATE hq_events SET archived_at = now(), archived_reason = 'manual'
       WHERE luma_id = 'evt-a'`,
    );

    await runSync({ rows: [row({ luma_id: "evt-a", type_id: type })] });

    const after = await event("evt-a");
    expect(after.archived_at).not.toBeNull();
    expect(after.archived_reason).toBe("manual");
  });

  it("un-archives an auto-archived event that reappears in Luma", async () => {
    const type = await typeId("Weekly coworking");
    await runSync({
      rows: [row({ luma_id: "evt-a", type_id: type }), row({ luma_id: "evt-b", type_id: type })],
    });
    await runSync({ rows: [row({ luma_id: "evt-a", type_id: type })] });
    expect((await event("evt-b")).archived_reason).toBe("missing");

    await runSync({
      rows: [row({ luma_id: "evt-a", type_id: type }), row({ luma_id: "evt-b", type_id: type })],
    });

    const back = await event("evt-b");
    expect(back.archived_at).toBeNull();
    expect(back.archived_reason).toBeNull();
  });

  it("archives nothing when Luma returns no events at all", async () => {
    const type = await typeId("Weekly coworking");
    await runSync({ rows: [row({ luma_id: "evt-a", type_id: type })] });

    await runSync({ rows: [], ids: [], reconcile: false });

    expect((await event("evt-a")).archived_at).toBeNull();
  });

  it("drops the writes of a sync that started before a newer one committed", async () => {
    const type = await typeId("Weekly coworking");
    await runSync({ rows: [row({ luma_id: "evt-a", type_id: type, name: "Fresh" })] });

    // A sync that began before the one above committed: its data is stale, so
    // every guarded statement must no-op.
    const stale = new Date(Date.now() - 60_000).toISOString();
    await runSync({
      rows: [row({ luma_id: "evt-a", type_id: type, name: "Stale" })],
      startedAt: stale,
    });

    expect((await event("evt-a")).name).toBe("Fresh");
  });

  it("does not archive on a stale sync either", async () => {
    const type = await typeId("Weekly coworking");
    await runSync({
      rows: [row({ luma_id: "evt-a", type_id: type }), row({ luma_id: "evt-b", type_id: type })],
    });

    const stale = new Date(Date.now() - 60_000).toISOString();
    await runSync({ rows: [row({ luma_id: "evt-a", type_id: type })], startedAt: stale });

    expect((await event("evt-b")).archived_at).toBeNull();
  });

  it("advances last_success_at on success", async () => {
    const type = await typeId("Weekly coworking");
    const [before] = await run(`SELECT last_success_at FROM hq_luma_sync`);
    await runSync({ rows: [row({ luma_id: "evt-a", type_id: type })] });
    const [after] = await run(`SELECT last_success_at FROM hq_luma_sync`);

    expect(new Date(String(after.last_success_at)).getTime()).toBeGreaterThan(
      new Date(String(before.last_success_at)).getTime(),
    );
  });

  it("makes the pinned-fields CASE tolerate every pinnable column at once", async () => {
    const type = await typeId("Weekly coworking");
    await runSync({
      rows: [row({ luma_id: "evt-a", type_id: type, end_date: "2026-08-09" })],
    });
    await run(
      `UPDATE hq_events SET name='N', date='2020-01-01', end_date='2020-01-02',
         venue='V', cohost='C',
         pinned_fields = ARRAY['name','date','end_date','venue','cohost']
       WHERE luma_id = 'evt-a'`,
    );

    await runSync({
      rows: [
        row({
          luma_id: "evt-a",
          type_id: type,
          name: "Luma name",
          date: "2026-08-07",
          end_date: "2026-08-09",
          venue: "Luma venue",
          cohost: "Luma cohost",
        }),
      ],
    });

    const after = await event("evt-a");
    expect(after.name).toBe("N");
    expect(after.date).toBe("2020-01-01");
    expect(after.end_date).toBe("2020-01-02");
    expect(after.venue).toBe("V");
    expect(after.cohost).toBe("C");
    // luma_url is never pinnable — it always tracks Luma.
    expect(after.luma_url).toBe("https://luma.com/evt-a");
  });

  it("rolls back completely when a statement fails mid-transaction", async () => {
    const type = await typeId("Weekly coworking");
    await runSync({ rows: [row({ luma_id: "evt-a", type_id: type })] });
    const [before] = await run(`SELECT last_success_at FROM hq_luma_sync`);

    // A type_id that violates the foreign key aborts the upsert.
    await expect(
      runSync({
        rows: [
          row({ luma_id: "evt-b", type_id: "00000000-0000-0000-0000-000000000000" }),
        ],
      }),
    ).rejects.toThrow();

    expect(await event("evt-b")).toBeUndefined();
    const [after] = await run(`SELECT last_success_at FROM hq_luma_sync`);
    expect(after.last_success_at).toEqual(before.last_success_at);
  });
});

// These mirror the statements in lib/hq/actions/events.ts, which cannot be
// imported here (server-only). The point is the SQL guards themselves: the
// rules must hold in the database, not only in the UI that hides the buttons.
describe("event action guards", () => {
  const DELETE = `DELETE FROM hq_events WHERE id = $1 AND luma_id IS NULL RETURNING id`;
  const PIN = `UPDATE hq_events SET pinned_fields = array_append(pinned_fields, $2)
               WHERE id = $1 AND luma_id IS NOT NULL AND NOT ($2 = ANY(pinned_fields))
               RETURNING id`;

  async function insert(name: string, lumaId: string | null): Promise<string> {
    const [inserted] = await run(
      `INSERT INTO hq_events (name, date, type_id, luma_id)
       VALUES ($1, '2026-08-07', (SELECT id FROM hq_event_types WHERE label='Other'), $2)
       RETURNING id`,
      [name, lumaId],
    );
    return String(inserted.id);
  }

  it("refuses to delete a Luma-sourced event", async () => {
    const id = await insert("Mirrored", "evt-a");
    expect(await run(DELETE, [id])).toHaveLength(0);
    expect(await run(`SELECT id FROM hq_events WHERE id = $1`, [id])).toHaveLength(1);
  });

  it("deletes an external event", async () => {
    const id = await insert("Hand-entered", null);
    expect(await run(DELETE, [id])).toHaveLength(1);
    expect(await run(`SELECT id FROM hq_events WHERE id = $1`, [id])).toHaveLength(0);
  });

  it("pins a field only on Luma-sourced events, and only once", async () => {
    const luma = await insert("Mirrored", "evt-a");
    const external = await insert("Hand-entered", null);

    expect(await run(PIN, [luma, "name"])).toHaveLength(1);
    expect(await run(PIN, [luma, "name"])).toHaveLength(0); // already pinned
    expect(await run(PIN, [external, "name"])).toHaveLength(0); // nothing to pin against

    const [row] = await run(`SELECT pinned_fields FROM hq_events WHERE id = $1`, [luma]);
    expect(row.pinned_fields).toEqual(["name"]);
  });

  it("releases a pin", async () => {
    const id = await insert("Mirrored", "evt-a");
    await run(PIN, [id, "venue"]);
    await run(`UPDATE hq_events SET pinned_fields = array_remove(pinned_fields, $2) WHERE id = $1`, [
      id,
      "venue",
    ]);

    const [row] = await run(`SELECT pinned_fields FROM hq_events WHERE id = $1`, [id]);
    expect(row.pinned_fields).toEqual([]);
  });

  it("rejects an archived_reason outside the two the sync understands", async () => {
    const id = await insert("Mirrored", "evt-a");
    await expect(
      run(`UPDATE hq_events SET archived_at = now(), archived_reason = 'whatever' WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow();
  });
});
