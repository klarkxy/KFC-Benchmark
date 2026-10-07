import { describe, expect, it } from "vitest";
import type { PublicConfig, Task } from "@kitchensched/contracts";

import { applyEvent, createInitialState, seedStations } from "../src/replay/reducer";

/** Minimal public config: `seedStations` only reads `stations`. */
const config = {
  stations: [
    { id: "st.grill", kind: "grill", name: "Grill" },
    { id: "st.fryer", kind: "fryer", name: "Fryer" },
  ],
} as Pick<PublicConfig, "stations">;

const task = {
  id: "t1",
  recipe_id: "r.fry_fries",
  station_id: "st.fryer",
  batches: 2,
  started_at_ms: 0,
  finish_at_ms: 8000,
} as Task;

function startedTask(): ReturnType<typeof applyEvent> {
  return applyEvent(createInitialState(), {
    seq: 1,
    at_ms: 0,
    type: "task_started",
    payload: { task },
    state_version: 1,
  } as Parameters<typeof applyEvent>[1]);
}

describe("seedStations", () => {
  it("registers every station before any event, so the kitchen exists at t=0", () => {
    const state = seedStations(createInitialState(), config);
    expect(state.stations).toEqual([
      { id: "st.grill", task: null },
      { id: "st.fryer", task: null },
    ]);
  });

  it("keeps the config order and the task already folded in", () => {
    const started = seedStations(startedTask(), config);
    expect(started.stations).toEqual([
      { id: "st.grill", task: null },
      { id: "st.fryer", task },
    ]);
  });

  it("is idempotent: re-seeding returns the same state object", () => {
    const once = seedStations(createInitialState(), config);
    expect(seedStations(once, config)).toBe(once);
  });

  it("lets later events attach to a seeded station without duplicating it", () => {
    const seeded = seedStations(createInitialState(), config);
    const next = applyEvent(seeded, {
      seq: 1,
      at_ms: 0,
      type: "task_started",
      payload: { task },
      state_version: 1,
    } as Parameters<typeof applyEvent>[1]);
    expect(next.stations).toHaveLength(2);
    expect(next.stations[1]).toEqual({ id: "st.fryer", task });
  });
});
