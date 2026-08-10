// Archiving must declutter the board without quietly moving the numbers that
// projects contribute, so the precedence between active and archived events of
// the same name is pinned down here.
import { describe, expect, it } from "vitest";
import { attributeOutputs, type AttributableEvent } from "@/lib/hq/event-attribution";

const project = (eventSrc: string, over: { active?: boolean; gates?: number } = {}) => ({
  event_src: eventSrc,
  counts_as_active: over.active ?? true,
  gates_done: over.gates ?? 0,
});

const ev = (id: string, name: string, archived = false): AttributableEvent => ({
  id,
  name,
  archived,
});

describe("attributeOutputs", () => {
  it("attributes a project to the event whose name matches its source", () => {
    const outputs = attributeOutputs(
      [ev("e1", "Build Station")],
      [project("Build Station")],
      2,
    );
    expect(outputs.get("e1")).toEqual({ q: 1, a: 1, s: 0 });
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    const outputs = attributeOutputs([ev("e1", "Build Station")], [project("  build station ")], 0);
    expect(outputs.get("e1")?.q).toBe(1);
  });

  it("counts a submission only once every gate is done", () => {
    const outputs = attributeOutputs(
      [ev("e1", "Build Station")],
      [project("Build Station", { gates: 2 }), project("Build Station", { gates: 1 })],
      2,
    );
    expect(outputs.get("e1")).toEqual({ q: 2, a: 2, s: 1 });
  });

  it("never counts submissions when no gates are configured", () => {
    const outputs = attributeOutputs(
      [ev("e1", "Build Station")],
      [project("Build Station", { gates: 0 })],
      0,
    );
    expect(outputs.get("e1")?.s).toBe(0);
  });

  it("ignores projects with no source, even against a blank-named event", () => {
    const outputs = attributeOutputs([ev("e1", "")], [project("")], 0);
    expect(outputs.size).toBe(0);
  });

  it("gives an active event precedence over an archived one of the same name", () => {
    // The archived duplicate is listed first, so date order alone would pick it.
    const outputs = attributeOutputs(
      [ev("archived", "Build Station", true), ev("live", "Build Station")],
      [project("Build Station")],
      0,
    );
    expect(outputs.get("live")?.q).toBe(1);
    expect(outputs.has("archived")).toBe(false);
  });

  it("still attributes to an archived event when it is the only match", () => {
    const outputs = attributeOutputs(
      [ev("archived", "Build Station", true), ev("live", "Demo Day")],
      [project("Build Station")],
      0,
    );
    expect(outputs.get("archived")?.q).toBe(1);
  });

  it("keeps the first of several active events with the same name", () => {
    const outputs = attributeOutputs(
      [ev("first", "Build Station"), ev("second", "Build Station")],
      [project("Build Station")],
      0,
    );
    expect(outputs.get("first")?.q).toBe(1);
    expect(outputs.has("second")).toBe(false);
  });
});
