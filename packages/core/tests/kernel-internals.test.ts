import { describe, expect, it } from "vitest";
import { runScenario, verifyRun } from "../src/index.js";
import type { EventRecord, Observation } from "@kitchensched/contracts";
import { Kernel } from "../src/kernel.js";
import {
  controller,
  dec,
  deliver,
  eventsOf,
  makeConfig,
  observeAt,
  order,
  scripted,
  start,
} from "./fixtures.js";

describe("state_version discipline", () => {
  it("bumps only on committed world changes", () => {
    const config = makeConfig({ end_at_ms: 2_000, s3_ms: 500 });
    const orders = [order("o1", 500, [["fries", 1]])];
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3"), start("a2", "r_fries", "s3")]),
      dec([deliver("d1", "o1", [["lot-1", 1]]), deliver("d2", "o1", [["lot-1", 1]])]),
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(out.events.map((e) => [e.type, e.state_version])).toEqual([
      ["task_started", 1],
      ["action_rejected", 1], // rejection: no bump
      ["clock_advanced", 2],
      ["task_completed", 3],
      ["order_arrived", 4],
      ["order_delivered", 5],
      ["action_rejected", 5], // rejection: no bump
      ["clock_advanced", 6],
      ["run_finished", 6], // terminal log record: no bump
    ]);
    expect(candidate.observations.map((o) => o.state_version)).toEqual([0, 4, 6]);
    // The digest carries the same version the audit stream ends on.
    expect(canonicalStateVersion(out.events)).toBe(6);
  });
});

function canonicalStateVersion(events: EventRecord[]): number {
  return events[events.length - 1]?.state_version ?? -1;
}

describe("observation snapshot", () => {
  it("cannot be used to corrupt the world", () => {
    const config = makeConfig({ end_at_ms: 2_000, s3_ms: 500 });
    const orders = [order("o1", 500, [["fries", 1]])];
    const seen: { now: number; final: boolean; revenue: number; orders: number }[] = [];
    let call = 0;
    const vandal = controller((obs) => {
      call += 1;
      seen.push({
        now: obs.now_ms,
        final: obs.final,
        revenue: obs.revenue_minor,
        orders: obs.orders.length,
      });
      // Mutate everything the candidate can see; none of it may stick.
      obs.orders.length = 0;
      obs.orders.push({ id: "fake", arrived_at_ms: 0, items: [], value_minor: 10 ** 9 });
      obs.inventory.length = 0;
      for (const station of obs.stations) station.task_id = "hijacked";
      obs.running_tasks.push({
        id: "fake-task",
        recipe_id: "r_fries",
        station_id: "s3",
        batches: 99,
        started_at_ms: 0,
        finish_at_ms: 0,
      });
      obs.revenue_minor = 10 ** 9;
      obs.previous_results.length = 0;
      obs.previous_wake_result = { ok: false, code: "INVALID_WAKE_TIME", pending_wake_at_ms: 7 };
      obs.pending_wake_at_ms = 123;
      obs.state_version = 0;
      obs.final = !obs.final;
      return call === 1
        ? dec([start("a1", "r_fries", "s3")])
        : call === 2
          ? dec([deliver("d1", "o1", [["lot-1", 1]])])
          : dec();
    });

    const out = runScenario({ config, orderStream: orders, controller: vandal, policy_seed: 1 });

    expect(out.result.status).toBe("completed");
    expect(out.result.score_minor).toBe(300);
    expect(out.result.revenue_minor).toBe(300);
    // What each callback really saw, before the candidate vandalized it.
    expect(seen).toEqual([
      { now: 0, final: false, revenue: 0, orders: 0 },
      { now: 500, final: false, revenue: 0, orders: 1 },
      { now: 2_000, final: true, revenue: 300, orders: 0 },
    ]);
    const judged = verifyRun(config, orders, out.events);
    expect(judged.mismatches).toEqual([]);
    expect(judged.ok).toBe(true);
  });
});

describe("observation ordering", () => {
  it("sorts object arrays by stable id", () => {
    const config = makeConfig({ end_at_ms: 1_000, s3_ms: 500 });
    // Same arrival tick, ids deliberately out of alphabetical stream order.
    const orders = [
      order("o3", 500, [["fries", 1]]),
      order("o1", 500, [["fries", 1]]),
      order("o2", 500, [["fries", 1]]),
    ];
    const candidate = scripted([dec([start("a1", "r_fries", "s3", 4)])]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });
    const at_500 = observeAt(candidate, 1) as Observation;

    // Announced in stream order, presented sorted by id.
    expect(eventsOf(out.events, "order_arrived").map((e) => e.payload.order.id)).toEqual([
      "o3", "o1", "o2",
    ]);
    expect(at_500.orders.map((o) => o.id)).toEqual(["o1", "o2", "o3"]);
    expect(at_500.stations.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(at_500.inventory.map((l) => l.id)).toEqual(["lot-1"]);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });
});

describe("conservation ledger", () => {
  it("balances produced stock against inputs and deliveries", () => {
    const config = makeConfig({ end_at_ms: 4_000, s3_ms: 1_000 });
    const orders = [order("o1", 1_000, [["fries", 1]]), order("o2", 1_200, [["burger", 1], ["fries", 1]]), order("o3", 3_000, [["fries", 1]])];
    const plan = [
      dec([start("a1", "r_patty", "s4"), start("a2", "r_fries", "s3", 3)]), // t=0
      dec([start("a3", "r_burger", "s1", 1, [["lot-1", 1]])]), // t=500
      dec([deliver("d1", "o1", [["lot-2", 1]])]), // t=1000, the fries land with o1
      dec(), // t=1200, o2 waits for its burger
      dec([deliver("d2", "o2", [["lot-3", 1], ["lot-2", 1]])]), // t=1500
      dec([deliver("d3", "o3", [["lot-2", 1]])]), // t=3000
    ];
    const kernel = new Kernel({
      config,
      orderStream: orders,
      controller: scripted(plan),
      policy_seed: 1,
    });
    const out = kernel.run();

    expect(() => kernel.check_conservation()).not.toThrow();
    // 1 patty of raw meat, 3 potatoes and 1 bun went in; 3 fries and 1 burger
    // came out; 3 fries and 1 burger left the building.
    expect(kernel.rawConsumption()).toEqual({ bun: 1, meat: 1, potato: 3 });
    expect(out.result.score_minor).toBe(300 + 800 + 300);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });
});

describe("judge: station occupancy", () => {
  it("rejects two tasks overlapping on one station", () => {
    const config = makeConfig({ end_at_ms: 3_000 });
    const candidate = scripted([dec([start("p1", "r_patty", "s4"), start("p2", "r_patty", "s5")])]);
    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });
    expect(verifyRun(config, [], out.events).ok).toBe(true);

    const forged = out.events.map((ev) => ({ ...ev })) as EventRecord[];
    for (const ev of forged) {
      if (ev.type !== "task_started") continue;
      const task = (ev.payload as { task: { station_id: string } }).task;
      if (task.station_id === "s5") task.station_id = "s4";
    }
    const result = verifyRun(config, [], forged);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/is busy until 500/);
  });

  it("rejects a task that claims a station its recipe cannot use", () => {
    const config = makeConfig({ end_at_ms: 3_000 });
    const candidate = scripted([dec([start("p1", "r_patty", "s4")])]);
    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    const forged = out.events.map((ev) => ({ ...ev })) as EventRecord[];
    for (const ev of forged) {
      if (ev.type === "task_started") {
        (ev.payload as { task: { station_id: string } }).task.station_id = "s3";
      }
    }
    const result = verifyRun(config, [], forged);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/cannot run recipe/);
  });

  it("rejects a batch count outside the station limit", () => {
    const config = makeConfig({ end_at_ms: 3_000 });
    const candidate = scripted([dec([start("f1", "r_fries", "s3")])]);
    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    const forged = out.events.map((ev) => ({ ...ev })) as EventRecord[];
    for (const ev of forged) {
      if (ev.type === "task_started") {
        (ev.payload as { task: { batches: number } }).task.batches = 99;
      }
    }
    const result = verifyRun(config, [], forged);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/batches 99 outside/);
  });

  it("rejects a lot stamped with the wrong production time", () => {
    const config = makeConfig({ end_at_ms: 3_000 });
    const candidate = scripted([dec([start("p1", "r_patty", "s4")])]);
    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    const forged = out.events.map((ev) => ({ ...ev })) as EventRecord[];
    for (const ev of forged) {
      if (ev.type === "task_completed") {
        const lots = (ev.payload as { lots: { produced_at_ms: number }[] }).lots;
        if (lots[0] !== undefined) lots[0] = { ...lots[0], produced_at_ms: 0 };
      }
    }
    const result = verifyRun(config, [], forged);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/produced_at_ms != task finish time/);
  });
});

describe("judge: unusable input", () => {
  it("returns a mismatch list instead of throwing on garbage events", () => {
    const config = makeConfig();
    const garbage = [
      { seq: 1, at_ms: 0, type: "task_started", payload: null, state_version: 1 },
      { seq: 2, at_ms: 0, type: "nonsense", payload: 5, state_version: 1 },
      { seq: 9, at_ms: 99, type: "order_delivered", payload: {}, state_version: 7 },
    ] as unknown as EventRecord[];

    const result = verifyRun(config, [], garbage);
    expect(result.ok).toBe(false);
    expect(result.mismatches.length).toBeGreaterThan(0);
  });
});
