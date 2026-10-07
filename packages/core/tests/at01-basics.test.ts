import { describe, expect, it } from "vitest";
import { runScenario, verifyRun } from "../src/index.js";
import {
  controller,
  dec,
  deliver,
  eventsOf,
  eventTypes,
  idle,
  makeConfig,
  nowSeq,
  observeAt,
  order,
  resultsForCall,
  scripted,
  start,
} from "./fixtures.js";

/** AT01: t=0 observe has no orders, and a legal start works. */
describe("AT01 first observe", () => {
  it("observes the pristine world at t=0 and completes a whole-order delivery", () => {
    const config = makeConfig({ end_at_ms: 5_000 });
    const orders = [order("o1", 1_000, [["fries", 1]])];
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3")]), // t=0, prep phase
      dec(), // t=800, the task produced lot-1
      dec([deliver("a2", "o1", [["lot-1", 1]])]), // t=1000, order arrived
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 7 });
    const first = observeAt(candidate, 0);

    expect(first).toBeDefined();
    expect(first?.now_ms).toBe(0);
    expect(first?.final).toBe(false);
    expect(first?.state_version).toBe(0);
    expect(first?.orders).toEqual([]);
    expect(first?.inventory).toEqual([]);
    expect(first?.running_tasks).toEqual([]);
    expect(first?.revenue_minor).toBe(0);
    expect(first?.previous_results).toEqual([]);
    expect(first?.previous_wake_result).toBeNull();
    expect(first?.pending_wake_at_ms).toBeNull();
    expect(first?.stations.every((s) => s.task_id === null)).toBe(true);

    expect(nowSeq(candidate)).toEqual([0, 800, 1_000, 5_000]);
    expect(out.result.status).toBe("completed");
    expect(out.result.score_minor).toBe(300);
    expect(out.result.revenue_minor).toBe(300);
    expect(out.result.delivered_orders).toBe(1);
    expect(out.result.failure_code).toBeNull();
    expect(out.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(eventTypes(out.events)).toEqual([
      "task_started",
      "clock_advanced",
      "task_completed",
      "clock_advanced",
      "order_arrived",
      "order_delivered",
      "clock_advanced",
      "run_finished",
    ]);
    expect(out.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(out.events.map((e) => e.at_ms)).toEqual([0, 800, 800, 1_000, 1_000, 1_000, 5_000, 5_000]);
    // run_finished seals the stream with the very same digest the host stores.
    const last = out.events[out.events.length - 1];
    expect(last?.payload).toMatchObject({
      status: "completed",
      score_minor: 300,
      revenue_minor: 300,
      delivered_orders: 1,
      state_hash: out.stateHash,
    });
    expect(verifyRun(config, orders, out.events)).toEqual({ ok: true, mismatches: [] });
  });

  it("hands the started task, the seed and a seeded rng to the candidate", () => {
    const config = makeConfig();
    const candidate = scripted([dec([start("a1", "r_fries", "s3")])]);
    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 42 });

    expect(candidate.initConfigs).toHaveLength(1);
    expect(candidate.seeds).toEqual([42]);
    expect(candidate.randoms[0]).toBeGreaterThanOrEqual(0);
    expect(candidate.randoms[0]).toBeLessThan(1);
    expect(resultsForCall(candidate, 0)[0]).toEqual({
      action_id: "a1",
      ok: true,
      code: "OK",
      entity_id: "task-1",
      replayed: false,
    });
    expect(out.stats).toMatchObject({ decisions: 3, totalActions: 1 });
  });
});

/** AT02: a task started in prep may span the first order arrival. */
describe("AT02 prep phase continuity", () => {
  it("keeps the running task visible across the first order arrival", () => {
    const config = makeConfig({ end_at_ms: 5_000, s3_ms: 1_500 });
    const orders = [order("o1", 1_000, [["fries", 1]])];
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3")]), // t=0 -> finishes 1500
      dec([start("a2", "r_fries", "s3")]), // t=1000, order arrived, s3 still busy
      dec([deliver("a3", "o1", [["lot-1", 1]])]), // t=1500
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });
    const at_arrival = observeAt(candidate, 1);

    expect(at_arrival?.now_ms).toBe(1_000);
    expect(at_arrival?.orders.map((o) => o.id)).toEqual(["o1"]);
    expect(at_arrival?.inventory).toEqual([]);
    expect(at_arrival?.running_tasks).toEqual([
      {
        id: "task-1",
        recipe_id: "r_fries",
        station_id: "s3",
        batches: 1,
        started_at_ms: 0,
        finish_at_ms: 1_500,
      },
    ]);
    expect(at_arrival?.stations.find((s) => s.id === "s3")?.task_id).toBe("task-1");
    expect(out.result.score_minor).toBe(300);
    // A second start while s3 is busy is a business rejection, not a crash.
    expect(resultsForCall(candidate, 1)[0]).toMatchObject({ code: "STATION_BUSY" });
    expect(out.result.status).toBe("completed");
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });
});

/** AT03: two starts on one station in a single response. */
describe("AT03 station contention", () => {
  it("accepts the first and rejects the second with STATION_BUSY", () => {
    const config = makeConfig({ end_at_ms: 3_000 });
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3"), start("a2", "r_fries", "s3")]),
    ]);

    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });
    const results = resultsForCall(candidate, 0);

    expect(results.map((r) => [r.action_id, r.ok, r.code])).toEqual([
      ["a1", true, "OK"],
      ["a2", false, "STATION_BUSY"],
    ]);
    expect(eventsOf(out.events, "task_started")).toHaveLength(1);
    const rejected = eventsOf(out.events, "action_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload.result.code).toBe("STATION_BUSY");
    // A rejection is a log append: it must not move state_version.
    expect(rejected[0]?.state_version).toBe(1);
    expect(out.stats.totalActions).toBe(2);
  });
});

/** AT04: two stations competing for the same lot. */
describe("AT04 lot contention", () => {
  it("lets only the first action consume the lot", () => {
    const config = makeConfig({ end_at_ms: 1_000 });
    const candidate = scripted([
      dec([start("a1", "r_patty", "s4")]), // t=0 -> lot-1 (patty x1) at 500
      dec([
        start("a2", "r_burger", "s1", 1, [["lot-1", 1]]), // wins, occupies s1 until 1500
        start("a3", "r_burger", "s2", 1, [["lot-1", 1]]), // loses: the lot is gone
      ]),
    ]);

    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });
    const results = resultsForCall(candidate, 1);
    const after = candidate.observations[candidate.observations.length - 1];

    expect(results.map((r) => [r.action_id, r.ok, r.code])).toEqual([
      ["a2", true, "OK"],
      ["a3", false, "UNKNOWN_LOT"],
    ]);
    // Exactly one burger task exists; the loser consumed nothing.
    expect(eventsOf(out.events, "task_started")).toHaveLength(2);
    expect(after?.stations.find((s) => s.id === "s1")?.task_id).toBe("task-2");
    expect(after?.stations.find((s) => s.id === "s2")?.task_id).toBeNull();
    // The winner really consumed it: the lot leaves the observation but stays
    // in the ledger at zero quantity.
    expect(after?.inventory).toEqual([]);
    expect(verifyRun(config, [], out.events).ok).toBe(true);
  });
});

/** AT05: wrong / missing / extra produced inputs are atomic rejections. */
describe("AT05 input validation", () => {
  it("rejects and changes nothing when the produced inputs do not match", () => {
    const config = makeConfig({ end_at_ms: 4_000, s3_ms: 500 });
    const candidate = scripted([
      // lot-1 patty x1 and lot-2 fries x1 both exist at t=500.
      dec([start("p1", "r_patty", "s4"), start("p2", "r_fries", "s3")]),
      dec([
        start("m1", "r_burger", "s1"), // missing patty
        start("m2", "r_burger", "s1", 1, [["lot-1", 2]]), // wrong quantity
        start("m3", "r_burger", "s1", 1, [["lot-2", 1]]), // wrong item
        start("m4", "r_burger", "s1", 1, [["lot-1", 1], ["lot-2", 1]]), // extra item
      ]),
    ]);

    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });
    const results = resultsForCall(candidate, 1);
    const after = observeAt(candidate, 2);

    expect(results.map((r) => [r.action_id, r.ok, r.code])).toEqual([
      ["m1", false, "INVALID_INPUT"],
      ["m2", false, "INVALID_INPUT"],
      ["m3", false, "INVALID_INPUT"],
      ["m4", false, "INVALID_INPUT"],
    ]);
    // No material change: only the two prep tasks ran, s1 is idle, and both
    // lots keep their quantities.
    expect(eventsOf(out.events, "task_started")).toHaveLength(2);
    expect(after?.now_ms).toBe(4_000);
    expect(after?.running_tasks).toHaveLength(0);
    expect(after?.stations.find((s) => s.id === "s1")?.task_id).toBeNull();
    expect(after?.inventory.map((l) => [l.id, l.quantity])).toEqual([
      ["lot-1", 1],
      ["lot-2", 1],
    ]);
    expect(out.result.revenue_minor).toBe(0);
    expect(out.result.status).toBe("completed");
    expect(verifyRun(config, [], out.events).ok).toBe(true);
  });
});

/** AT06: duplicate lot_id. */
describe("AT06 duplicate lot", () => {
  it("rejects a repeated lot_id on start", () => {
    const config = makeConfig({ end_at_ms: 4_000 });
    const candidate = scripted([
      dec([start("a1", "r_patty", "s4")]),
      dec([start("a2", "r_burger", "s1", 1, [["lot-1", 1], ["lot-1", 1]])]),
    ]);

    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    expect(resultsForCall(candidate, 1)[0]?.code).toBe("DUPLICATE_LOT");
    expect(eventsOf(out.events, "action_rejected")[0]?.payload.result.code).toBe("DUPLICATE_LOT");
    expect(observeAt(candidate, 1)?.inventory.map((l) => [l.id, l.quantity])).toEqual([
      ["lot-1", 1],
    ]);
    expect(verifyRun(config, [], out.events).ok).toBe(true);
  });

  it("rejects a repeated lot_id on deliver too", () => {
    const config = makeConfig({ end_at_ms: 4_000 });
    // The order arrives on the same tick the batch is produced.
    const orders = [order("o1", 800, [["fries", 2]])];
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3", 2)]), // t=0 -> lot-1 fries x2 at 800
      dec([deliver("a2", "o1", [["lot-1", 1], ["lot-1", 1]])]),
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(resultsForCall(candidate, 1)[0]?.code).toBe("DUPLICATE_LOT");
    expect(out.result.revenue_minor).toBe(0);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });
});

/** AT08: unlimited_raw needs no lot reference and can never be sold. */
describe("AT08 unlimited_raw", () => {
  it("starts a raw-only recipe with no lots and cannot sell raw material", () => {
    const config = makeConfig({ end_at_ms: 4_000 });
    expect(config.items.find((i) => i.id === "potato")).toMatchObject({
      supply: "unlimited_raw",
      orderable: false,
      price_minor: 0,
    });

    const candidate = scripted([
      dec([start("a1", "r_fries", "s3")]),
      // A raw lot can never exist, so raw material can never be sold.
      dec([deliver("a2", "o1", [["potato-1", 1]])]),
    ]);

    const orders = [order("o1", 800, [["fries", 1]])];
    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });
    const started = resultsForCall(candidate, 0);
    const rawAttempt = resultsForCall(candidate, 1);

    expect(started[0]).toEqual({
      action_id: "a1",
      ok: true,
      code: "OK",
      entity_id: "task-1",
      replayed: false,
    });
    expect(rawAttempt[0]).toMatchObject({ action_id: "a2", ok: false, code: "UNKNOWN_LOT" });
    // Only the recipe output exists; the raw input is virtual.
    expect(observeAt(candidate, 1)?.inventory.map((l) => l.item_id)).toEqual(["fries"]);
    expect(out.result.revenue_minor).toBe(0);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });
});

describe("contract basics", () => {
  it("runs an empty controller to the deadline", () => {
    const config = makeConfig({ end_at_ms: 1_000 });
    const out = runScenario({ config, orderStream: [], controller: idle(), policy_seed: 3 });
    expect(out.result.status).toBe("completed");
    expect(out.result.score_minor).toBe(0);
  });

  it("turns a controller exception into candidate_failed", () => {
    const config = makeConfig();
    const candidate = controller(() => {
      throw new Error("boom");
    });
    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 3 });
    expect(out.result.failure_code).toBe("PROTOCOL_ERROR");
    expect(out.result.score_minor).toBe(0);
  });

  it("rejects a module that does not satisfy the controller contract", () => {
    const config = makeConfig();
    expect(() =>
      runScenario({
        config,
        orderStream: [],
        controller: {} as never,
        policy_seed: 1,
      }),
    ).toThrow(TypeError);
  });
});
