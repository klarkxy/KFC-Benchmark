import { describe, expect, it } from "vitest";
import { runScenario, verifyRun } from "../src/index.js";
import {
  dec,
  deliver,
  eventsOf,
  eventTypes,
  idle,
  makeConfig,
  nowSeq,
  observeAt,
  order,
  scripted,
  start,
} from "./fixtures.js";

/** AT13: everything at one tick merges into exactly one observe. */
describe("AT13 same-tick merge", () => {
  it("merges two task completions and one order arrival into one callback", () => {
    const config = makeConfig({ end_at_ms: 3_000, s3_ms: 1_000 });
    const orders = [order("o1", 1_000, [["fries", 1]])];
    const candidate = scripted([
      dec([
        start("p1", "r_patty", "s4"), // -> 500
        start("p2", "r_patty", "s5"), // -> 500
        start("f1", "r_fries", "s3"), // -> 1000
      ]),
      dec(), // t=500, both patties land
      dec([deliver("d1", "o1", [["lot-3", 1]])]), // t=1000, fries land with the order
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(nowSeq(candidate)).toEqual([0, 500, 1_000, 3_000]);
    // At t=1000 three things happen and produce one callback.
    const at_1000 = out.events.filter((e) => e.at_ms === 1_000).map((e) => e.type);
    expect(at_1000).toEqual([
      "clock_advanced",
      "task_completed",
      "order_arrived",
      "order_delivered",
    ]);
    expect(candidate.observations.filter((o) => o.now_ms === 1_000)).toHaveLength(1);
    // The two patties from t=500 are still on hand next to the fresh fries.
    expect(observeAt(candidate, 2)?.inventory.map((l) => [l.id, l.item_id])).toEqual([
      ["lot-1", "patty"],
      ["lot-2", "patty"],
      ["lot-3", "fries"],
    ]);
    // Two completions on one tick keep their frozen queue order.
    expect(
      eventsOf(out.events, "task_completed")
        .filter((e) => e.at_ms === 500)
        .map((e) => e.payload.task.id),
    ).toEqual(["task-1", "task-2"]);
    expect(out.result.score_minor).toBe(300);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });
});

/** AT14: a task finishing exactly at the deadline is deliverable. */
describe("AT14 finish at deadline", () => {
  it("settles the batch first and then delivers it in the final observe", () => {
    const config = makeConfig({ end_at_ms: 1_000, s3_ms: 1_000 });
    const orders = [order("o1", 500, [["fries", 1]])];
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3")]), // t=0, finishes exactly at 1000
      dec(), // t=500, the order arrives
      dec([deliver("d1", "o1", [["lot-1", 1]])]), // t=1000, final
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });
    const final = observeAt(candidate, 2);

    expect(final?.now_ms).toBe(1_000);
    expect(final?.final).toBe(true);
    expect(final?.inventory.map((l) => l.id)).toEqual(["lot-1"]);
    expect(out.result.final_action_results).toEqual([
      { action_id: "d1", ok: true, code: "OK", entity_id: "dlv-1", replayed: false },
    ]);
    expect(out.result.status).toBe("completed");
    expect(out.result.score_minor).toBe(300);
    expect(out.result.delivered_orders).toBe(1);
    // The completion is settled before the delivery, both at the deadline.
    expect(out.events.filter((e) => e.at_ms === 1_000).map((e) => e.type)).toEqual([
      "clock_advanced",
      "task_completed",
      "order_delivered",
      "run_finished",
    ]);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });
});

/** AT15: a task finishing after the deadline yields nothing. */
describe("AT15 finish after deadline", () => {
  it("produces no sellable inventory when the batch misses by one millisecond", () => {
    const config = makeConfig({ end_at_ms: 1_000, s3_ms: 1_001 });
    const orders = [order("o1", 500, [["fries", 1]])];
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3")]), // finishes at 1001
      dec(), // t=500
      dec([deliver("d1", "o1", [["lot-1", 1]])]), // t=1000, final: nothing to sell
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });
    const final = observeAt(candidate, 2);

    expect(final?.final).toBe(true);
    expect(final?.inventory).toEqual([]);
    expect(final?.running_tasks.map((t) => [t.id, t.finish_at_ms])).toEqual([["task-1", 1_001]]);
    expect(out.result.final_action_results[0]).toMatchObject({ code: "UNKNOWN_LOT" });
    expect(eventsOf(out.events, "task_completed")).toHaveLength(0);
    expect(out.result.status).toBe("completed");
    expect(out.result.score_minor).toBe(0);
    expect(out.result.revenue_minor).toBe(0);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });
});

/** AT16: the final callback is deliver-only. */
describe("AT16 final callback", () => {
  it("rejects start, accepts deliver and reports both in EndResult", () => {
    const config = makeConfig({ end_at_ms: 1_000, s3_ms: 1_000 });
    const orders = [order("o1", 500, [["fries", 1]])];
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3")]),
      dec(),
      dec(
        [start("s2", "r_fries", "s3"), deliver("d1", "o1", [["lot-1", 1]])],
        1_200, // the endgame registers no wake
      ),
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(out.result.status).toBe("completed");
    expect(out.result.final_action_results).toEqual([
      { action_id: "s2", ok: false, code: "DEADLINE_REACHED", entity_id: null, replayed: false },
      { action_id: "d1", ok: true, code: "OK", entity_id: "dlv-1", replayed: false },
    ]);
    expect(out.result.final_wake_result).toEqual({
      ok: false,
      code: "INVALID_WAKE_TIME",
      pending_wake_at_ms: null,
    });
    expect(out.result.score_minor).toBe(300);
    // The rejected endgame start created no task and no completion event.
    expect(eventsOf(out.events, "task_started")).toHaveLength(1);
    expect(eventsOf(out.events, "order_delivered")).toHaveLength(1);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });

  it("accepts a null wake in the final callback", () => {
    const config = makeConfig({ end_at_ms: 1_000 });
    const candidate = scripted([dec(), dec([], null)]);
    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    expect(out.result.final_wake_result).toEqual({
      ok: true,
      code: "CANCELED",
      pending_wake_at_ms: null,
    });
    expect(out.result.status).toBe("completed");
  });

  it("settles immediately after the final response with no further callbacks", () => {
    const config = makeConfig({ end_at_ms: 1_000, s3_ms: 1_500 });
    const candidate = scripted([dec([start("a1", "r_fries", "s3")]), dec()]);
    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    expect(nowSeq(candidate)).toEqual([0, 1_000]);
    expect(out.events.map((e) => e.type)).toEqual([
      "task_started",
      "clock_advanced",
      "run_finished",
    ]);
  });
});

/** AT17: ignoring everything still ends normally at the deadline. */
describe("AT17 idle run", () => {
  it("completes with score 0 and never exits early", () => {
    const config = makeConfig({ end_at_ms: 5_000 });
    const orders = [order("o1", 1_000, [["fries", 1]]), order("o2", 3_000, [["burger", 1]])];
    const candidate = idle();

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(out.result).toMatchObject({
      status: "completed",
      score_minor: 0,
      revenue_minor: 0,
      delivered_orders: 0,
      failure_code: null,
    });
    expect(nowSeq(candidate)).toEqual([0, 1_000, 3_000, 5_000]);
    expect(candidate.observations[3]?.final).toBe(true);
    expect(eventTypes(out.events)).toEqual([
      "clock_advanced",
      "order_arrived",
      "clock_advanced",
      "order_arrived",
      "clock_advanced",
      "run_finished",
    ]);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });
});

/** AT18: empty decisions advance to the next internal event. */
describe("AT18 clock advance", () => {
  it("walks every internal event and then jumps to the deadline", () => {
    const config = makeConfig({ end_at_ms: 1_000, s3_ms: 800 });
    const orders = [order("o1", 100, [["fries", 1]]), order("o2", 300, [["fries", 1]])];
    const candidate = scripted([dec([start("a1", "r_fries", "s3")])]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(nowSeq(candidate)).toEqual([0, 100, 300, 800, 1_000]);
    expect(out.stats.decisions).toBe(5);
    // The run does not stop at the last order: it settles the batch and the
    // deadline too.
    expect(out.events.map((e) => [e.at_ms, e.type])).toEqual([
      [0, "task_started"],
      [100, "clock_advanced"],
      [100, "order_arrived"],
      [300, "clock_advanced"],
      [300, "order_arrived"],
      [800, "clock_advanced"],
      [800, "task_completed"],
      [1_000, "clock_advanced"],
      [1_000, "run_finished"],
    ]);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });

  it("ignores orders that arrive at or after the deadline", () => {
    const config = makeConfig({ end_at_ms: 1_000 });
    const orders = [order("o1", 1_000, [["fries", 1]]), order("o2", 2_000, [["fries", 1]])];
    const candidate = idle();

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(nowSeq(candidate)).toEqual([0, 1_000]);
    expect(eventsOf(out.events, "order_arrived")).toHaveLength(0);
    expect(out.result.status).toBe("completed");
    // The judge refuses to certify a stream that never announced them.
    expect(verifyRun(config, orders, out.events).ok).toBe(false);
  });
});
