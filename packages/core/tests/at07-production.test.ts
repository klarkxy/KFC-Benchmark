import { describe, expect, it } from "vitest";
import { runScenario, verifyRun } from "../src/index.js";
import {
  dec,
  deliver,
  eventsOf,
  makeConfig,
  nowSeq,
  observeAt,
  order,
  resultsForCall,
  scripted,
  start,
} from "./fixtures.js";

/** AT07: batches multiply quantities, duration stays fixed. */
describe("AT07 batches", () => {
  it("multiplies inputs and outputs while keeping the fixed station duration", () => {
    const config = makeConfig({ end_at_ms: 4_000, s1_ms: 1_000 });
    const orders = [order("o1", 2_000, [["burger", 2]])];
    const candidate = scripted([
      // 2 patties in one 500ms batch.
      dec([start("a1", "r_patty", "s4", 2)]),
      dec([
        start("a2", "r_burger", "s1", 2, [["lot-1", 2]]), // 2 burgers in one 1000ms batch
        start("a3", "r_burger", "s2", 4, [["lot-1", 4]]), // s2 max_batches is 3
      ]),
      dec(), // t=1500, the burgers are finished but the order has not arrived
      dec([deliver("a4", "o1", [["lot-2", 2]])]), // t=2000
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });
    const started = eventsOf(out.events, "task_started").map((e) => e.payload.task);
    const completed = eventsOf(out.events, "task_completed");

    expect(resultsForCall(candidate, 1)[1]).toMatchObject({ ok: false, code: "INVALID_BATCH" });
    // Duration is the station entry value and does not scale with batches.
    expect(started.map((t) => [t.recipe_id, t.batches, t.finish_at_ms - t.started_at_ms])).toEqual([
      ["r_patty", 2, 500],
      ["r_burger", 2, 1_000],
    ]);
    expect(completed[0]?.payload.lots.map((l) => [l.item_id, l.quantity])).toEqual([
      ["patty", 2],
    ]);
    expect(completed[1]?.payload.lots.map((l) => [l.item_id, l.quantity])).toEqual([
      ["burger", 2],
    ]);
    expect(completed[0]?.payload.lots[0]?.produced_at_ms).toBe(500);
    expect(out.result.score_minor).toBe(1_000);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });

  it("rejects batches below 1 and non-integers", () => {
    const config = makeConfig({ end_at_ms: 2_000 });
    const candidate = scripted([
      dec([
        start("z0", "r_fries", "s3", 0),
        start("z1", "r_fries", "s3", -1),
        start("z2", "r_fries", "s3", 1.5),
        start("z3", "r_fries", "s3", 5), // s3 max_batches is 4
        start("z4", "r_fries", "s3", 4),
      ]),
    ]);

    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    expect(resultsForCall(candidate, 0).map((r) => [r.action_id, r.code])).toEqual([
      ["z0", "INVALID_BATCH"],
      ["z1", "INVALID_BATCH"],
      ["z2", "INVALID_BATCH"],
      ["z3", "INVALID_BATCH"],
      ["z4", "OK"],
    ]);
    expect(eventsOf(out.events, "task_started")).toHaveLength(1);
    expect(verifyRun(config, [], out.events).ok).toBe(true);
  });
});

/** AT09: an incomplete order never changes inventory or revenue. */
describe("AT09 incomplete order", () => {
  it("rejects partial, substituted and over-supplied deliveries", () => {
    const config = makeConfig({ end_at_ms: 3_000 });
    const orders = [order("o1", 800, [["burger", 2]])];
    const candidate = scripted([
      dec([start("p1", "r_patty", "s4")]), // t=0 -> lot-1 patty at 500
      dec([start("b1", "r_burger", "s1", 1, [["lot-1", 1]])]), // t=500 -> lot-2 burger at 1500
      dec(), // t=800, the order arrives
      dec([
        deliver("d1", "o1", [["lot-2", 1]]), // short by one burger
        deliver("d2", "o1", [["lot-2", 1], ["lot-2", 1]]), // duplicate lot reference
        deliver("d3", "o1", []), // nothing at all
        deliver("d4", "o1", [["lot-1", 1]]), // lot-1 was already consumed by b1
      ]),
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(resultsForCall(candidate, 3).map((r) => [r.action_id, r.code])).toEqual([
      ["d1", "INCOMPLETE_ORDER"],
      ["d2", "DUPLICATE_LOT"],
      ["d3", "INCOMPLETE_ORDER"],
      ["d4", "UNKNOWN_LOT"],
    ]);
    // Inventory and revenue are untouched: lot-2 still holds one burger.
    const after = observeAt(candidate, 4);
    expect(after?.now_ms).toBe(3_000);
    expect(after?.inventory.map((l) => [l.id, l.item_id, l.quantity])).toEqual([
      ["lot-2", "burger", 1],
    ]);
    expect(after?.revenue_minor).toBe(0);
    expect(out.result.revenue_minor).toBe(0);
    expect(out.result.status).toBe("completed");
    expect(eventsOf(out.events, "order_delivered")).toHaveLength(0);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });
});

/** AT10: one order can book at most one revenue. */
describe("AT10 single revenue per order", () => {
  it("books one revenue even when two action ids target the same order", () => {
    const config = makeConfig({ end_at_ms: 3_000 });
    const orders = [order("o1", 800, [["fries", 1]])];
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3")]), // t=0 -> lot-1 at 800
      dec([
        deliver("d1", "o1", [["lot-1", 1]]),
        deliver("d2", "o1", [["lot-1", 1]]),
      ]),
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(resultsForCall(candidate, 1).map((r) => [r.action_id, r.ok, r.code])).toEqual([
      ["d1", true, "OK"],
      ["d2", false, "ALREADY_DELIVERED"],
    ]);
    expect(eventsOf(out.events, "order_delivered")).toHaveLength(1);
    expect(out.result.revenue_minor).toBe(300);
    expect(out.result.score_minor).toBe(300);
    expect(out.result.delivered_orders).toBe(1);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });

  it("refuses a delivery for an order that never arrived", () => {
    const config = makeConfig({ end_at_ms: 3_000 });
    const orders = [order("late", 2_500, [["fries", 1]])];
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3")]),
      dec([deliver("d1", "late", [["lot-1", 1]])]), // t=800, the order is not here yet
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(resultsForCall(candidate, 1)[0]).toMatchObject({ ok: false, code: "UNKNOWN_ORDER" });
    expect(out.result.revenue_minor).toBe(0);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });
});

/** AT11: replay of identical content, conflict on different content. */
describe("AT11 idempotency", () => {
  it("replays a cached success without re-executing it", () => {
    const config = makeConfig({ end_at_ms: 3_000 });
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3")]), // t=0, OK, lot-1 at 800
      dec([start("a1", "r_fries", "s3")]), // t=800, identical content
      dec([start("a2", "r_fries", "s3")]), // t=3000 is the final phase, so DEADLINE_REACHED
    ]);

    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    expect(resultsForCall(candidate, 1)[0]).toEqual({
      action_id: "a1",
      ok: true,
      code: "OK",
      entity_id: "task-1",
      replayed: true,
    });
    // No second task and no new event from the replay itself.
    expect(eventsOf(out.events, "task_started")).toHaveLength(1);
    // The only rejection is the endgame start from the final callback.
    expect(eventsOf(out.events, "action_rejected").map((e) => e.payload.result.code)).toEqual([
      "DEADLINE_REACHED",
    ]);
    expect(out.result.final_action_results[0]).toMatchObject({
      action_id: "a2",
      ok: false,
      code: "DEADLINE_REACHED",
    });
    expect(out.stats.totalActions).toBe(3);
    expect(verifyRun(config, [], out.events).ok).toBe(true);
  });

  it("returns ACTION_ID_CONFLICT when the same id carries different content", () => {
    const config = makeConfig({ end_at_ms: 3_000 });
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3")]), // t=0, OK
      dec([start("a1", "r_fries", "s3", 2)]), // same id, batches 2
    ]);

    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    expect(resultsForCall(candidate, 1)[0]).toMatchObject({
      action_id: "a1",
      ok: false,
      code: "ACTION_ID_CONFLICT",
      replayed: false,
    });
    expect(eventsOf(out.events, "action_rejected")[0]?.payload.result.code).toBe(
      "ACTION_ID_CONFLICT",
    );
    expect(eventsOf(out.events, "task_started")).toHaveLength(1);
    expect(verifyRun(config, [], out.events).ok).toBe(true);
  });

  it("treats a reordered lot list as identical content", () => {
    const config = makeConfig({ end_at_ms: 3_000, s1_ms: 500 });
    const candidate = scripted([
      // lot-1 and lot-2 (one patty each) both exist at t=500.
      dec([start("p1", "r_patty", "s4"), start("p2", "r_patty", "s5")]),
      dec([start("b1", "r_burger", "s1", 2, [["lot-1", 1], ["lot-2", 1]])]),
      dec([start("b1", "r_burger", "s1", 2, [["lot-2", 1], ["lot-1", 1]])]),
    ]);

    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    expect(resultsForCall(candidate, 1)[0]).toMatchObject({ ok: true, code: "OK" });
    // The replay is judged against the normalized action, not array order.
    expect(resultsForCall(candidate, 2)[0]).toMatchObject({
      action_id: "b1",
      ok: true,
      code: "OK",
      replayed: true,
    });
    expect(eventsOf(out.events, "task_started")).toHaveLength(3);
    expect(verifyRun(config, [], out.events).ok).toBe(true);
  });
});

/** AT12: a first business failure is cached; retrying needs a new id. */
describe("AT12 cached failures", () => {
  it("caches the first rejection and never re-runs it", () => {
    const config = makeConfig({ end_at_ms: 4_000 });
    const candidate = scripted([
      dec([
        start("bad1", "r_burger", "s1"), // INVALID_INPUT: no patty yet
        start("prep", "r_patty", "s4"), // OK -> lot-1 at 500
      ]),
      dec([
        start("bad1", "r_burger", "s1"), // same id and content: replayed, still no patty
        start("good", "r_burger", "s1", 1, [["lot-1", 1]]), // new id, now legal
      ]),
    ]);

    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });
    const first = resultsForCall(candidate, 0);
    const second = resultsForCall(candidate, 1);

    expect(first.map((r) => [r.action_id, r.ok, r.code])).toEqual([
      ["bad1", false, "INVALID_INPUT"],
      ["prep", true, "OK"],
    ]);
    expect(second.map((r) => [r.action_id, r.ok, r.code, r.replayed])).toEqual([
      ["bad1", false, "INVALID_INPUT", true],
      ["good", true, "OK", false],
    ]);
    // The replayed action created no task and no extra rejection event.
    const starts = eventsOf(out.events, "task_started").map((e) => e.payload.task.id);
    expect(starts).toEqual(["task-1", "task-2"]);
    expect(eventsOf(out.events, "action_rejected")).toHaveLength(1);
    expect(nowSeq(candidate)).toEqual([0, 500, 1_500, 4_000]);
    expect(verifyRun(config, [], out.events).ok).toBe(true);
  });
});
