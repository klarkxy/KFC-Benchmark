import { describe, expect, it } from "vitest";
import { Kernel, runScenario, verifyRun } from "../src/index.js";
import type { RunOutput } from "../src/index.js";
import {
  mulberry32,
  type Action,
  type ControllerModule,
  type Decision,
  type EventRecord,
  type Lot,
  type LotQty,
  type Observation,
  type Order,
  type PublicConfig,
  type Recipe,
} from "@kitchensched/contracts";
import { dec, makeConfig, order, scripted, start } from "./fixtures.js";

/**
 * Interactive mode must be the same kernel, only paused between decisions.
 * Every test here drives one plan twice — through `run()` and through
 * `beginInteractive` / `advanceInteractive` — and compares the results byte for
 * byte. The policy is a deterministic function of the observation plus one
 * mulberry32 tie-break stream, so both paths see identical inputs and draw
 * identical random values.
 */

/** Earliest-expiry-first (earliest production first) lot picking. */
function pickLots(
  inventory: readonly Lot[],
  stock: ReadonlyMap<string, number>,
  need: ReadonlyMap<string, number>,
): LotQty[] | null {
  const remaining = new Map(need);
  const refs: LotQty[] = [];
  const fefo = [...inventory].sort(
    (a, b) => a.produced_at_ms - b.produced_at_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const lot of fefo) {
    const want = remaining.get(lot.item_id) ?? 0;
    if (want <= 0) continue;
    const available = stock.get(lot.id) ?? 0;
    const take = Math.min(want, available);
    if (take <= 0) continue;
    refs.push({ lot_id: lot.id, quantity: take });
    remaining.set(lot.item_id, want - take);
  }
  for (const left of remaining.values()) if (left > 0) return null;
  return refs;
}

function createPolicy(config: PublicConfig, seed: number): (observation: Observation) => Decision {
  const rng = mulberry32(seed);
  const produced = new Set(
    config.items.filter((item) => item.supply === "produced").map((item) => item.id),
  );
  const recipes: Recipe[] = [...config.recipes].sort((a, b) => (a.id < b.id ? -1 : 1));
  let nextActionId = 0;

  return (observation: Observation): Decision => {
    const actions: Action[] = [];
    const stock = new Map<string, number>(observation.inventory.map((lot) => [lot.id, lot.quantity]));
    /** Items already committed by tasks started earlier in this same decision. */
    const projected = new Map<string, number>();
    const busy = new Set(
      observation.stations.filter((s) => s.task_id !== null).map((s) => s.id),
    );
    const spend = (refs: readonly LotQty[]): void => {
      for (const ref of refs) stock.set(ref.lot_id, (stock.get(ref.lot_id) ?? 0) - ref.quantity);
    };
    const available = (item_id: string): number =>
      observation.inventory
        .filter((lot) => lot.item_id === item_id)
        .reduce((sum, lot) => sum + (stock.get(lot.id) ?? 0), 0) -
      (projected.get(item_id) ?? 0);

    // 1. Deliver the most valuable order the kitchen can already fill.
    const queue = [...observation.orders].sort(
      (a, b) => b.value_minor - a.value_minor || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    for (const pending of queue) {
      if (actions.length >= 3) break;
      const need = new Map(pending.items.map((line) => [line.item_id, line.quantity]));
      const refs = pickLots(observation.inventory, stock, need);
      if (refs === null) continue;
      spend(refs);
      actions.push({
        type: "deliver",
        action_id: `a${++nextActionId}`,
        order_id: pending.id,
        output_lots: refs,
      });
    }

    // 2. Produce exactly what the waiting orders still need, oldest first.
    const unmet: [string, number][] = [];
    for (const pending of [...queue].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      for (const line of pending.items) unmet.push([line.item_id, line.quantity]);
    }
    const wanted = new Map<string, number>();
    for (const [item_id, quantity] of unmet) {
      wanted.set(item_id, (wanted.get(item_id) ?? 0) + quantity);
    }
    for (const [item_id, quantity] of [...wanted.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (actions.length >= 3) break;
      const recipe = recipes.find((r) => r.outputs.some((out) => out.item_id === item_id));
      if (recipe === undefined) continue;
      const free = recipe.station_options.filter((option) => !busy.has(option.station_id));
      if (free.length === 0) continue;
      const option = free[Math.floor(rng() * free.length)] ?? free[0];
      if (option === undefined) continue;
      const inputs = recipe.inputs.filter((line) => produced.has(line.item_id));
      const outQty = recipe.outputs.find((out) => out.item_id === item_id)?.quantity ?? 1;
      const capacity = Math.min(
        option.max_batches,
        Math.floor(quantity / outQty),
        ...inputs.map((line) => Math.floor(available(line.item_id) / line.quantity)),
      );
      if (capacity < 1) continue;
      const need = new Map(inputs.map((line) => [line.item_id, line.quantity * capacity]));
      const refs = pickLots(observation.inventory, stock, need);
      if (refs === null) continue;
      spend(refs);
      busy.add(option.station_id);
      projected.set(item_id, (projected.get(item_id) ?? 0) + outQty * capacity);
      actions.push({
        type: "start",
        action_id: `a${++nextActionId}`,
        recipe_id: recipe.id,
        station_id: option.station_id,
        batches: capacity,
        input_lots: refs,
      });
    }

    // 3. Occasionally sit out until a wall-clock offset, so wakes are exercised.
    const now = observation.now_ms;
    const wakeAt = now + 250;
    const wake_at_ms =
      !observation.final && wakeAt <= config.end_at_ms && rng() < 0.25 ? wakeAt : null;
    return { actions, wake_at_ms };
  };
}

interface Played {
  output: RunOutput;
  events: EventRecord[];
  observations: Observation[];
}

/** Drives the interactive API with one policy call per observation. */
function playInteractive(kernel: Kernel, policy: (observation: Observation) => Decision): Played {
  const events: EventRecord[] = [];
  const observations: Observation[] = [];
  let step = kernel.beginInteractive();
  for (let guard = 0; guard < 10_000; guard += 1) {
    if (step.kind === "invalid") throw new Error(`interactive run rejected a decision: ${step.reason}`);
    events.push(...step.events);
    if (step.kind === "done") return { output: step.output, events, observations };
    observations.push(step.observation);
    step = kernel.advanceInteractive(policy(step.observation));
  }
  throw new Error("interactive run did not terminate");
}

function playController(
  config: PublicConfig,
  orders: readonly Order[],
  policy: (observation: Observation) => Decision,
  seed: number,
): Played {
  const observations: Observation[] = [];
  const controller: ControllerModule = {
    init() {},
    decide(observation) {
      observations.push(observation);
      return policy(observation);
    },
  };
  return { output: runScenario({ config, orderStream: [...orders], controller, policy_seed: seed }), events: [], observations };
}

/** The equivalence assertion: same score, same hash, same events, same counters. */
describe("interactive equivalence", () => {
  const config = makeConfig({
    end_at_ms: 5_000,
    s1_ms: 900,
    s2_ms: 1_200,
    s3_ms: 700,
    prep_ms: 400,
  });
  const orders: Order[] = [
    order("o1", 700, [["fries", 2]]),
    order("o2", 1_400, [["burger", 1], ["fries", 1]]),
    order("o3", 2_100, [["fries", 3]]),
    order("o4", 2_900, [["burger2", 1], ["fries", 2]]),
    order("o5", 4_200, [["burger", 2]]),
  ];

  it("reproduces a run-to-completion run, decision for decision", () => {
    const seed = 20_261_007;
    const viaController = playController(config, orders, createPolicy(config, seed), seed);
    const kernel = new Kernel({
      config,
      orderStream: orders,
      controller: scripted([]),
      policy_seed: seed,
    });
    const played = playInteractive(kernel, createPolicy(config, seed));

    expect(played.output.result).toEqual(viaController.output.result);
    expect(played.output.stateHash).toBe(viaController.output.stateHash);
    expect(played.events).toEqual(viaController.output.events);
    expect(played.observations).toEqual(viaController.observations);
    expect(played.output.stats.decisions).toBe(viaController.output.stats.decisions);
    expect(played.output.stats.totalActions).toBe(viaController.output.stats.totalActions);
    // Wall clock is the one counter interactive mode deliberately leaves at 0.
    expect(played.output.stats.decisionWallMs).toBe(0);
    expect(viaController.output.stats.decisions).toBeGreaterThan(5);
    // Pinned so a kernel or policy change that silently alters the run fails
    // here instead of passing as a vacuously equal comparison.
    expect(played.output.result.score_minor).toBe(1_500);
    expect(played.output.stats.decisions).toBe(13);
    expect(verifyRun(config, orders, played.events).ok).toBe(true);
  });

  it("runs to the same budget failure as run() when max_decisions runs out", () => {
    const tight = makeConfig({ end_at_ms: 5_000, limits: { max_decisions: 4 } });
    const seed = 7;
    const viaController = playController(tight, orders, createPolicy(tight, seed), seed);
    const kernel = new Kernel({
      config: tight,
      orderStream: orders,
      controller: scripted([]),
      policy_seed: seed,
    });
    const played = playInteractive(kernel, createPolicy(tight, seed));

    expect(played.output.result.failure_code).toBe("BUDGET_EXCEEDED");
    expect(played.output.result.status).toBe("candidate_failed");
    expect(played.output.result).toEqual(viaController.output.result);
    expect(played.events).toEqual(viaController.output.events);
  });

  it("ignores a controller that would fail the run", () => {
    const seed = 3;
    const exploding: ControllerModule = {
      init() {
        throw new Error("init must not run in interactive mode");
      },
      decide() {
        throw new Error("decide must not run in interactive mode");
      },
    };
    const kernel = new Kernel({ config, orderStream: orders, controller: exploding, policy_seed: seed });
    const played = playInteractive(kernel, createPolicy(config, seed));

    expect(played.output.result.status).toBe("completed");
    expect(played.output.result.failure_code).toBeNull();
  });
});

describe("interactive invalid submissions", () => {
  const config = makeConfig({ end_at_ms: 2_000, s3_ms: 500 });
  const orders: Order[] = [order("o1", 500, [["fries", 1]])];

  it("rejects a malformed decision without touching the world", () => {
    const kernel = new Kernel({
      config,
      orderStream: orders,
      controller: scripted([]),
      policy_seed: 1,
    });
    const first = kernel.beginInteractive();
    expect(first.kind).toBe("observation");
    if (first.kind !== "observation") return;
    expect(first.observation.now_ms).toBe(0);
    expect(first.observation.state_version).toBe(0);
    expect(first.events).toEqual([]);

    const before = first.observation;
    for (const bad of [
      { actions: [{ type: "start", action_id: "x", recipe_id: "r_fries", station_id: "s3", batches: 1, input_lots: "nope" }], wake_at_ms: null },
      { actions: [], wake_at_ms: "later" },
      { actions: [{ type: "teleport", action_id: "y" }], wake_at_ms: null },
      { actions: [] },
      null,
      42,
    ]) {
      const step = kernel.advanceInteractive(bad as unknown as Decision);
      expect(step.kind).toBe("invalid");
      if (step.kind === "invalid") expect(step.reason).toMatch(/advanceInteractive/);
    }
    // Nothing moved: the t=0 observation is still the pending decision point,
    // and the very next valid action lands on it exactly as in run().
    const next = kernel.advanceInteractive(dec([start("a1", "r_fries", "s3")]));
    expect(next.kind).toBe("observation");
    if (next.kind !== "observation") return;
    expect(next.observation.now_ms).toBe(500);
    expect(next.observation.state_version).toBeGreaterThan(before.state_version);
    expect(next.observation.previous_results.map((r) => [r.action_id, r.code])).toEqual([
      ["a1", "OK"],
    ]);
    expect(next.events.map((e) => e.type)).toEqual(["task_started", "clock_advanced", "task_completed", "order_arrived"]);
  });

  it("keeps the session usable after an invalid submission mid-run", () => {
    const config = makeConfig({ end_at_ms: 2_500, s3_ms: 500 });
    const orders: Order[] = [order("o1", 500, [["fries", 1]]), order("o2", 1_500, [["fries", 1]])];
    // The stray UNKNOWN_RECIPE action is a business rejection, so run() sees
    // exactly the same plan; the replay below must match event for event.
    const plan = [
      dec([start("a1", "r_fries", "s3", 2)]),
      dec([deliverAction("d1", "o1", "lot-1")]),
      dec([
        { type: "start", action_id: "bad", recipe_id: "nope", station_id: "s3", batches: 1, input_lots: [] },
        deliverAction("d2", "o2", "lot-1"),
      ]),
      dec(),
    ];
    const viaController = runScenario({
      config,
      orderStream: orders,
      controller: scripted(plan),
      policy_seed: 1,
    });

    const kernel = new Kernel({ config, orderStream: orders, controller: scripted([]), policy_seed: 1 });
    const events: EventRecord[] = [];
    const seen: Observation[] = [];
    let step = kernel.beginInteractive();
    for (const [index, decision] of plan.entries()) {
      if (step.kind !== "observation") throw new Error(`unexpected step ${step.kind}`);
      events.push(...step.events);
      seen.push(step.observation);
      if (index === 2) {
        // A malformed submission in the middle changes nothing at all.
        const malformed = kernel.advanceInteractive({ wake_at_ms: null } as unknown as Decision);
        expect(malformed.kind).toBe("invalid");
      }
      step = kernel.advanceInteractive(decision);
      if (index === 1) {
        if (step.kind !== "observation") throw new Error("expected the t=1500 observation");
        expect(step.observation.previous_results.map((r) => r.code)).toEqual(["OK"]);
        expect(step.events.map((e) => e.type)).toEqual(["order_delivered", "clock_advanced", "order_arrived"]);
      }
    }
    if (step.kind !== "done") throw new Error("expected the run to finish");
    events.push(...step.events);

    expect(seen.map((o) => o.now_ms)).toEqual([0, 500, 1_500, 2_500]);
    expect(events).toEqual(viaController.events);
    expect(step.output.result.score_minor).toBe(600);
    expect(step.output.stateHash).toBe(viaController.stateHash);
    expect(verifyRun(config, orders, events).ok).toBe(true);
  });

  it("refuses steps out of order", () => {
    const kernel = new Kernel({
      config,
      orderStream: orders,
      controller: scripted([]),
      policy_seed: 1,
    });
    const early = kernel.advanceInteractive(dec());
    expect(early.kind).toBe("invalid");
    if (early.kind === "invalid") expect(early.reason).toMatch(/beginInteractive/);

    expect(kernel.beginInteractive().kind).toBe("observation");
    const twice = kernel.beginInteractive();
    expect(twice.kind).toBe("invalid");
    if (twice.kind === "invalid") expect(twice.reason).toMatch(/already interactive/);
  });
});

describe("interactive endgame", () => {
  const config = makeConfig({ end_at_ms: 1_500, s3_ms: 500 });
  const orders: Order[] = [order("o1", 500, [["fries", 1]]), order("o2", 1_400, [["fries", 1]])];

  it("delivers the final observation, then finishes", () => {
    const kernel = new Kernel({ config, orderStream: orders, controller: scripted([]), policy_seed: 1 });
    const plan = [
      dec([start("a1", "r_fries", "s3", 4)]), // t=0     -> 4 fries at t=500
      dec([deliverAction("d1", "o1", "lot-1")]), // t=500  -> o1 served
      dec([deliverAction("d2", "o2", "lot-1")]), // t=1400 -> o2 served
      dec(), // t=1500 -> final, deliver-only
    ];
    const seen: Observation[] = [];
    const events: EventRecord[] = [];
    let step = kernel.beginInteractive();
    for (const decision of plan) {
      if (step.kind !== "observation") throw new Error(`unexpected step ${step.kind}`);
      events.push(...step.events);
      seen.push(step.observation);
      step = kernel.advanceInteractive(decision);
    }
    expect(step.kind).toBe("done");
    if (step.kind !== "done") return;
    events.push(...step.events);

    expect(seen.map((o) => [o.now_ms, o.final])).toEqual([
      [0, false],
      [500, false],
      [1_400, false],
      [1_500, true],
    ]);
    expect(step.output.result.status).toBe("completed");
    expect(step.output.result.score_minor).toBe(600);
    expect(step.output.result.delivered_orders).toBe(2);
    expect(step.output.result.final_action_results).toEqual([]);
    expect(step.output.result.final_wake_result).toEqual({
      ok: true,
      code: "CANCELED",
      pending_wake_at_ms: null,
    });
    expect(events.map((e) => e.type)).toContain("run_finished");
    expect(events[events.length - 1]?.type).toBe("run_finished");
    expect(verifyRun(config, orders, events).ok).toBe(true);

    const after = kernel.advanceInteractive(dec());
    expect(after.kind).toBe("invalid");
    if (after.kind === "invalid") expect(after.reason).toMatch(/already finished/);
  });

  it("serves a last-minute order from the final observation", () => {
    const kernel = new Kernel({ config, orderStream: orders, controller: scripted([]), policy_seed: 1 });
    const plan = [
      dec([start("a1", "r_fries", "s3", 4)]),
      dec([deliverAction("d1", "o1", "lot-1")]),
      dec(), // t=1400: hold the last fry for the final callback
      dec([deliverAction("d3", "o2", "lot-1")]), // t=1500, final: deliver-only
    ];
    let step = kernel.beginInteractive();
    const events: EventRecord[] = [];
    for (const decision of plan) {
      if (step.kind !== "observation") throw new Error(`unexpected step ${step.kind}`);
      events.push(...step.events);
      step = kernel.advanceInteractive(decision);
    }
    expect(step.kind).toBe("done");
    if (step.kind !== "done") return;
    events.push(...step.events);

    expect(step.output.result.score_minor).toBe(600);
    expect(step.output.result.final_action_results.map((r) => [r.action_id, r.code, r.entity_id])).toEqual([
      ["d3", "OK", "dlv-2"],
    ]);
    expect(step.output.stateHash).toBe(
      runScenario({ config, orderStream: orders, controller: scripted(plan), policy_seed: 1 }).stateHash,
    );
    expect(verifyRun(config, orders, events).ok).toBe(true);
  });

  it("refuses a start action in the final observation but records it as a result", () => {
    const kernel = new Kernel({ config, orderStream: orders, controller: scripted([]), policy_seed: 1 });
    const events: EventRecord[] = [];
    let step = kernel.beginInteractive();
    for (const decision of [
      dec([start("a1", "r_fries", "s3", 4)]),
      dec([deliverAction("d1", "o1", "lot-1")]),
      dec([deliverAction("d2", "o2", "lot-1")]),
    ]) {
      if (step.kind !== "observation") throw new Error(`unexpected step ${step.kind}`);
      events.push(...step.events);
      step = kernel.advanceInteractive(decision);
    }
    if (step.kind !== "observation") throw new Error("expected the final observation");
    events.push(...step.events);
    expect(step.observation.final).toBe(true);

    // A start is refused by the business layer, not by the interactive layer.
    const refused = kernel.advanceInteractive(dec([start("late", "r_fries", "s3")]));
    expect(refused.kind).toBe("done");
    if (refused.kind !== "done") return;
    events.push(...refused.events);
    expect(refused.output.result.final_action_results.map((r) => [r.action_id, r.code])).toEqual([
      ["late", "DEADLINE_REACHED"],
    ]);
    expect(refused.output.result.status).toBe("completed");
    expect(events.map((e) => e.type)).toContain("action_rejected");
    expect(verifyRun(config, orders, events).ok).toBe(true);
  });
});

describe("interactive wake lifecycle", () => {
  it("mirrors AT19: replace, reject, cancel, and drop at the deadline", () => {
    const config = makeConfig({ end_at_ms: 1_000 });
    const orders: Order[] = [order("o1", 100, [["fries", 1]])];
    const plan = [
      dec([], 500), // t=0    -> SCHEDULED 500
      dec([], 50), // t=100  -> INVALID_WAKE_TIME, keeps 500
      dec([], 800), // t=500  -> replaces with 800
      dec([], null), // t=800  -> cancel
      dec([], null), // t=1000 -> endgame, nothing pending
    ];
    const viaController = runScenario({
      config,
      orderStream: orders,
      controller: scripted(plan),
      policy_seed: 1,
    });

    const kernel = new Kernel({ config, orderStream: orders, controller: scripted([]), policy_seed: 1 });
    const seen: Observation[] = [];
    const events: EventRecord[] = [];
    let step = kernel.beginInteractive();
    for (const decision of plan) {
      if (step.kind !== "observation") throw new Error(`unexpected step ${step.kind}`);
      events.push(...step.events);
      seen.push(step.observation);
      step = kernel.advanceInteractive(decision);
    }
    if (step.kind !== "done") throw new Error("expected the run to finish");
    events.push(...step.events);

    expect(seen.map((o) => o.now_ms)).toEqual([0, 100, 500, 800, 1_000]);
    expect(seen.map((o) => o.pending_wake_at_ms)).toEqual([null, 500, null, null, null]);
    expect(
      seen.map((o) => (o.previous_wake_result === null ? null : o.previous_wake_result.code)),
    ).toEqual([null, "SCHEDULED", "INVALID_WAKE_TIME", "SCHEDULED", "CANCELED"]);
    expect(events).toEqual(viaController.events);
    // Everything matches except the wall-clock counter interactive never reads.
    expect(step.output.result).toEqual(viaController.result);
    expect(step.output.stateHash).toBe(viaController.stateHash);
    expect(step.output.stats.decisions).toBe(viaController.stats.decisions);
    expect(step.output.stats.totalActions).toBe(viaController.stats.totalActions);
    expect(step.output.stats.decisionWallMs).toBe(0);
    expect(verifyRun(config, orders, events).ok).toBe(true);
  });
});

/** Local helper so the invalid-decision test can spell out a deliver action. */
function deliverAction(action_id: string, order_id: string, lot_id: string): Action {
  return { type: "deliver", action_id, order_id, output_lots: [{ lot_id, quantity: 1 }] };
}
