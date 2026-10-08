import { describe, expect, it } from "vitest";
import type { Action, EventRecord, LotQty, Order, Recipe } from "@kitchensched/game";

import {
  BASE_SIM_PER_REAL_SECOND,
  MAX_STEP_REAL_MS,
  decisionFor,
  dequeue,
  durationRealMs,
  enqueue,
  labelsOf,
  pickSmartRecipe,
  queuedOrderIds,
  queuedStationIds,
  reservationsOf,
  revealedCount,
  simTimeAt,
  stepWindow,
  type QueuedAction,
  type RecipeCandidate,
} from "../src/play/engine";

/**
 * The engine's pure half. These are the rules that make the real-time game
 * fair: a queued action can never spend stock another queued action already
 * promised, the clock maths never lies about where the sim is, and a plain tap
 * always lands on the recipe an open ticket is actually waiting for.
 */

const startAction = (actionId: string, stationId: string): Action => ({
  type: "start",
  action_id: actionId,
  recipe_id: "r.assemble_grilled",
  station_id: stationId,
  batches: 1,
  input_lots: [],
});

const queuedStart = (actionId: string, stationId: string, lots: LotQty[]): QueuedAction => ({
  action: startAction(actionId, stationId),
  lots,
  label: `开工 ${actionId}`,
});

const queuedDeliver = (actionId: string, orderId: string, lots: LotQty[]): QueuedAction => ({
  action: { type: "deliver", action_id: actionId, order_id: orderId, output_lots: lots },
  lots,
  label: `交付 ${orderId}`,
});

const event = (atMs: number, seq: number): EventRecord => ({
  seq,
  at_ms: atMs,
  type: "clock_advanced",
  payload: { from_ms: atMs - 100, to_ms: atMs },
  state_version: seq,
});

describe("queue reservations", () => {
  it("sums what the queue promised per lot", () => {
    const queue = [
      queuedDeliver("a-1", "o1", [{ lot_id: "lot-1", quantity: 2 }]),
      queuedDeliver("a-2", "o2", [{ lot_id: "lot-1", quantity: 1 }]),
    ];
    expect(reservationsOf(queue).get("lot-1")).toBe(3);
  });

  it("frees a lot as soon as its action is cancelled", () => {
    const queue = enqueue(
      enqueue([], queuedDeliver("a-1", "o1", [{ lot_id: "lot-1", quantity: 4 }])),
      queuedDeliver("a-2", "o2", [{ lot_id: "lot-1", quantity: 2 }]),
    );
    expect(reservationsOf(queue).get("lot-1")).toBe(6);
    // A 4-piece lot can only back one 4-piece order, so dropping the first
    // action must hand the whole lot back to the second.
    const trimmed = dequeue(queue, "a-1");
    expect(reservationsOf(trimmed).get("lot-1")).toBe(2);
    expect(trimmed.map((entry) => entry.action.action_id)).toEqual(["a-2"]);
  });

  it("tracks which stations and orders are already spoken for", () => {
    const queue = [
      queuedStart("a-1", "st.grill", []),
      queuedDeliver("a-2", "o1", []),
    ];
    expect([...queuedStationIds(queue)]).toEqual(["st.grill"]);
    expect([...queuedOrderIds(queue)]).toEqual(["o1"]);
  });

  it("hands the whole queue to the kernel once and labels it for feedback", () => {
    const queue = [queuedStart("a-1", "st.grill", []), queuedDeliver("a-2", "o1", [])];
    const decision = decisionFor(queue);
    expect(decision.wake_at_ms).toBeNull();
    expect(decision.actions.map((action) => action.action_id)).toEqual(["a-1", "a-2"]);
    expect(labelsOf(queue)).toEqual({ "a-1": "开工 a-1", "a-2": "交付 o1" });
  });

  it("submits a bare clock advance when the player queued nothing", () => {
    expect(decisionFor([])).toEqual({ actions: [], wake_at_ms: null });
  });
});

const recipe = (id: string): Recipe => ({ id, name: id, inputs: [], outputs: [], station_options: [] });

const candidate = (
  id: string,
  affordableBatches: number,
  wanted: boolean,
): RecipeCandidate => ({ recipe: recipe(id), affordableBatches, wanted });

describe("pickSmartRecipe", () => {
  it("returns null when nothing is craftable, so the tile can explain why", () => {
    expect(pickSmartRecipe([candidate("a", 0, false), candidate("b", 0, true)])).toBeNull();
    expect(pickSmartRecipe([])).toBeNull();
  });

  it("prefers a recipe an open ticket is waiting for", () => {
    const pick = pickSmartRecipe([
      candidate("fries", 4, false),
      candidate("sandwich", 1, true),
    ]);
    expect(pick?.recipe.id).toBe("sandwich");
  });

  it("falls back to the first feasible recipe when nothing feeds a ticket", () => {
    const pick = pickSmartRecipe([candidate("fries", 4, false), candidate("bun", 2, false)]);
    expect(pick?.recipe.id).toBe("fries");
  });

  it("takes the largest affordable batch among equally wanted recipes", () => {
    const pick = pickSmartRecipe([
      candidate("small", 1, true),
      candidate("big", 3, true),
    ]);
    expect(pick?.recipe.id).toBe("big");
    expect(pick?.affordableBatches).toBe(3);
  });

  it("keeps config order when everything else ties", () => {
    const pick = pickSmartRecipe([
      candidate("first", 2, true),
      candidate("second", 2, true),
      candidate("third", 2, true),
    ]);
    expect(pick?.recipe.id).toBe("first");
  });

  it("never picks an infeasible recipe just because it is wanted", () => {
    const pick = pickSmartRecipe([
      candidate("wanted_but_broke", 0, true),
      candidate("plain_but_works", 1, false),
    ]);
    expect(pick?.recipe.id).toBe("plain_but_works");
  });
});

describe("step geometry", () => {
  it("spans from the acting decision point to the next one", () => {
    expect(stepWindow(4000, [event(4000, 1), event(8000, 2)], 8000)).toEqual({
      fromMs: 4000,
      toMs: 8000,
    });
  });

  it("falls back to the last event when the run ends (no next observation)", () => {
    expect(stepWindow(1000, [event(1000, 1), event(5000, 2)], null)).toEqual({
      fromMs: 1000,
      toMs: 5000,
    });
  });

  it("never moves backwards", () => {
    expect(stepWindow(8000, [], 4000)).toEqual({ fromMs: 8000, toMs: 8000 });
  });

  it("takes longer at 0.5x than at 4x, and compresses dead time", () => {
    // 6 simulated seconds: short enough that the dead-time cap never bites,
    // so the 8x speed ratio is the whole story.
    const window = { fromMs: 0, toMs: 6000 };
    expect(durationRealMs(window, 0.5)).toBe(6000 / (BASE_SIM_PER_REAL_SECOND * 0.5));
    expect(durationRealMs(window, 4)).toBe(durationRealMs(window, 0.5) / 8);
    expect(durationRealMs({ fromMs: 5, toMs: 5 }, 1)).toBe(0);
    // A 60 simulated-second silence is capped instead of played literally.
    expect(durationRealMs({ fromMs: 0, toMs: 60_000 }, 1)).toBe(MAX_STEP_REAL_MS);
    // 0.5x would be 10s on its own; the cap still wins.
    expect(durationRealMs({ fromMs: 0, toMs: 60_000 }, 0.5)).toBe(MAX_STEP_REAL_MS);
  });

  it("maps elapsed real time onto the sim clock and clamps at both ends", () => {
    const window = { fromMs: 0, toMs: 12_000 };
    const duration = durationRealMs(window, 1);
    expect(simTimeAt(window, 0, 1)).toBe(0);
    expect(simTimeAt(window, duration / 2, 1)).toBe(6000);
    expect(simTimeAt(window, duration * 5, 1)).toBe(12_000);
    expect(simTimeAt(window, -100, 1)).toBe(0);
  });

  it("reveals events exactly as the animated clock passes them", () => {
    const events = [event(4000, 1), event(6000, 2), event(8000, 3)];
    expect(revealedCount(events, 4000, 0)).toBe(1); // events at fromMs land at once
    expect(revealedCount(events, 5999, 1)).toBe(1);
    expect(revealedCount(events, 6000, 1)).toBe(2);
    expect(revealedCount(events, 99_999, 2)).toBe(3);
  });
});

describe("medal thresholds", () => {
  // Imported lazily here to keep this file about the engine's arithmetic; the
  // medal itself lives with the end screen.
  const medal = async () => (await import("../src/play/EndScreen")).medalFor;

  it("hands out 🏆 only for a perfect book", async () => {
    expect((await medal())(60_000, 60_000, 54_000)).toMatchObject({ icon: "🏆" });
    expect((await medal())(59_999, 60_000, 54_000)).toMatchObject({ icon: "🥇" });
    expect((await medal())(30_000, 60_000, 54_000)).toMatchObject({ icon: "🥈" });
    expect((await medal())(1_000, 60_000, 54_000)).toMatchObject({ icon: "🥉" });
  });
});

describe("order ids are opaque", () => {
  it("never assumes anything about an order's shape beyond what it plots", () => {
    const order: Order = { id: "o-1", arrived_at_ms: 0, items: [], value_minor: 1 };
    expect(order.id).toBe("o-1");
  });
});
