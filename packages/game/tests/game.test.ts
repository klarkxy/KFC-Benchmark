import { describe, expect, it } from "vitest";
import { runScenario, verifyRun } from "@kitchensched/core";
import type {
  Action,
  ControllerModule,
  Decision,
  ItemQty,
  Lot,
  Observation,
  Order,
  Recipe,
} from "@kitchensched/contracts";

import {
  buildReplayFile,
  createActionIdFactory,
  createGameSession,
  GAME_ENGINE_VERSION,
  planDeliverOutputs,
  planLots,
  planStartInputs,
  producedItemIds,
  scenarioHashFor,
  serializeReplayFile,
  type GameSession,
} from "../src/index.js";
import { EASY_CONFIG, EASY_ORDERS, EASY_STREAM } from "./fixtures.js";

const CONFIG = EASY_CONFIG;
const ORDERS = EASY_ORDERS;
const PRODUCED = producedItemIds(CONFIG);
const RECIPES_BY_OUTPUT = new Map<string, Recipe>();
for (const recipe of CONFIG.recipes) {
  for (const out of recipe.outputs) {
    if (!RECIPES_BY_OUTPUT.has(out.item_id)) RECIPES_BY_OUTPUT.set(out.item_id, recipe);
  }
}

const MAX_ACTIONS_PER_DECISION = 12;

/**
 * A demand-driven kitchen planner, deliberately built on the package's own
 * FEFO helpers: it is the same work a player's click-through does, so the full
 * session test doubles as a usability check of the helpers.
 */
function planActions(session: GameSession): Action[] {
  const observation = session.observation;
  if (observation === null) return [];
  const actions: Action[] = [];
  const busy = new Set(
    observation.stations.filter((s) => s.task_id !== null).map((s) => s.id),
  );
  const reserved = new Map<string, number>();
  const projected = new Map<string, number>();
  const onHand = (item_id: string): number =>
    observation.inventory
      .filter((lot) => lot.item_id === item_id)
      .reduce((sum, lot) => sum + lot.quantity - (reserved.get(lot.id) ?? 0), 0) -
    (projected.get(item_id) ?? 0);

  const ensure = (item_id: string, quantity: number, depth: number): boolean => {
    if (onHand(item_id) >= quantity) return true;
    if (depth >= 5 || actions.length >= MAX_ACTIONS_PER_DECISION) return false;
    const recipe = RECIPES_BY_OUTPUT.get(item_id);
    if (recipe === undefined) return false;
    const inputs = recipe.inputs.filter((line) => PRODUCED.has(line.item_id));
    const outQty = recipe.outputs.find((out) => out.item_id === item_id)?.quantity ?? 1;

    const tryStart = (): boolean => {
      const free = recipe.station_options.filter((option) => !busy.has(option.station_id));
      const option = free[0];
      if (option === undefined) return false;
      const batches = Math.min(
        option.max_batches,
        Math.floor(quantity / outQty),
        ...(inputs.length > 0
          ? inputs.map((line) => Math.floor(onHand(line.item_id) / line.quantity))
          : [Number.MAX_SAFE_INTEGER]),
      );
      if (batches < 1) return false;
      const plan = planStartInputs(observation.inventory, recipe, batches, PRODUCED, reserved);
      if (!plan.complete) return false;
      for (const ref of plan.lots) reserved.set(ref.lot_id, (reserved.get(ref.lot_id) ?? 0) + ref.quantity);
      busy.add(option.station_id);
      projected.set(item_id, (projected.get(item_id) ?? 0) + outQty * batches);
      actions.push({
        type: "start",
        action_id: session.nextActionId(),
        recipe_id: recipe.id,
        station_id: option.station_id,
        batches,
        input_lots: plan.lots,
      });
      return true;
    };

    if (tryStart()) return true;
    // Not enough inputs yet: push the upstream lines first, then retry once.
    for (const line of inputs) ensure(line.item_id, line.quantity, depth + 1);
    return tryStart();
  };

  // Serve what is on hand, most valuable order first.
  for (const order of [...observation.orders].sort(
    (a, b) => b.value_minor - a.value_minor || (a.id < b.id ? -1 : 1),
  )) {
    if (actions.length >= MAX_ACTIONS_PER_DECISION) break;
    const plan = planDeliverOutputs(observation.inventory, order, reserved);
    if (!plan.complete) continue;
    for (const ref of plan.lots) reserved.set(ref.lot_id, (reserved.get(ref.lot_id) ?? 0) + ref.quantity);
    actions.push({
      type: "deliver",
      action_id: session.nextActionId(),
      order_id: order.id,
      output_lots: plan.lots,
    });
  }
  // Then cook for the oldest waiting orders, oldest order first.
  for (const order of [...observation.orders].sort(
    (a, b) => a.arrived_at_ms - b.arrived_at_ms || (a.id < b.id ? -1 : 1),
  )) {
    for (const line of order.items) ensure(line.item_id, line.quantity, 0);
  }
  return actions;
}

/** Plays the easy practice scenario to its deadline. */
function playEasySession(policy_seed = 20_261_007): GameSession {
  const session = createGameSession({ config: CONFIG, orders: ORDERS, policy_seed });
  for (let guard = 0; !session.finished && guard < 5_000; guard += 1) {
    const result = session.submit({ actions: planActions(session), wake_at_ms: null });
    if (!result.ok) throw new Error(`submit rejected: ${result.reason}`);
  }
  return session;
}

describe("game session: a full easy scenario", () => {
  it("reaches the deadline with a plausible score and a judge-clean stream", () => {
    const session = playEasySession();
    const output = session.done;

    expect(session.finished).toBe(true);
    expect(session.observation).toBeNull();
    expect(output).not.toBeNull();
    expect(output?.result.status).toBe("completed");
    expect(output?.result.failure_code).toBeNull();
    expect(output?.stateHash).toMatch(/^[0-9a-f]{64}$/);
    // The stream the browser session produced passes the independent judge,
    // exactly like a host-run submission would.
    expect(verifyRun(CONFIG, ORDERS, session.events).ok).toBe(true);
    expect(session.events).toEqual(output?.events);
    expect(session.events[0]?.seq).toBe(1);
    expect(session.events[session.events.length - 1]?.type).toBe("run_finished");
  });

  it("serves several of the sixteen orders", () => {
    const output = playEasySession().done;
    const book = ORDERS.reduce((sum, order) => sum + order.value_minor, 0);

    expect(output?.result.delivered_orders).toBeGreaterThanOrEqual(10);
    expect(output?.result.score_minor).toBeGreaterThan(0);
    expect(output?.result.score_minor).toBeLessThan(book);
    // Whole-order settlement: the score is exactly the sum of the delivered
    // orders' frozen values, whatever order they were served in.
    const delivered = session_delivered_ids(output?.events ?? []);
    expect(delivered).toHaveLength(output?.result.delivered_orders ?? -1);
    const expected = ORDERS.filter((order) => delivered.includes(order.id)).reduce(
      (sum, order) => sum + order.value_minor,
      0,
    );
    expect(output?.result.score_minor).toBe(expected);
  });

  it("is reproducible: the same seed and the same clicks replay identically", () => {
    const first = playEasySession(4_242);
    const second = playEasySession(4_242);
    expect(second.events).toEqual(first.events);
    expect(second.done?.stateHash).toBe(first.done?.stateHash);
    expect(second.done?.result).toEqual(first.done?.result);
  });
});

function session_delivered_ids(events: { type: string; payload: unknown }[]): string[] {
  const ids: string[] = [];
  for (const event of events) {
    if (event.type === "order_delivered") {
      ids.push((event.payload as { order_id: string }).order_id);
    }
  }
  return ids;
}

describe("game session: submission handling", () => {
  it("starts paused at the t=0 observation", () => {
    const session = createGameSession({ config: CONFIG, orders: ORDERS, policy_seed: 1 });
    expect(session.observation?.now_ms).toBe(0);
    expect(session.observation?.final).toBe(false);
    expect(session.observation?.orders).toEqual([]);
    expect(session.done).toBeNull();
    expect(session.events).toEqual([]);
  });

  it("rejects a malformed decision without changing anything", () => {
    const session = createGameSession({ config: CONFIG, orders: ORDERS, policy_seed: 1 });
    const before = session.observation;
    const eventsBefore = session.events.length;

    for (const bad of [{ actions: [{ type: "start" }] }, { wake_at_ms: 5 }, "nope", 7]) {
      const result = session.submit(bad as unknown as Decision);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/advanceInteractive/);
    }
    expect(session.observation).toBe(before);
    expect(session.events).toHaveLength(eventsBefore);
    expect(session.done).toBeNull();

    const accepted = session.submit({ actions: [], wake_at_ms: null });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.observation?.now_ms).toBe(60_000);
  });

  it("refuses submissions after the run is over", () => {
    const session = createGameSession({ config: CONFIG, orders: [], policy_seed: 1 });
    // With no orders the clock simply runs to the deadline: the t=0 decision,
    // then the final deliver-only one.
    for (let guard = 0; !session.finished && guard < 10; guard += 1) {
      const result = session.submit({ actions: [], wake_at_ms: null });
      expect(result.ok).toBe(true);
    }
    expect(session.finished).toBe(true);
    expect(session.done?.result.status).toBe("completed");

    const after = session.submit({ actions: [], wake_at_ms: null });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toMatch(/already finished/);
  });

  it("hands out unique action ids", () => {
    const factory = createActionIdFactory();
    expect([factory(), factory(), factory()]).toEqual(["a-1", "a-2", "a-3"]);

    const session = createGameSession({ config: CONFIG, orders: ORDERS, policy_seed: 1 });
    const ids = [session.nextActionId(), session.nextActionId()];
    expect(ids).toEqual(["a-1", "a-2"]);
    // Ids never repeat across sessions either, so a shared replay cannot
    // collide with the kernel's action_id cache.
    expect(createActionIdFactory()()).toBe("a-1");
  });

  it("reports business rejections as results, not as invalid submissions", () => {
    const session = createGameSession({ config: CONFIG, orders: ORDERS, policy_seed: 1 });
    const result = session.submit({
      actions: [
        {
          type: "deliver",
          action_id: session.nextActionId(),
          order_id: "o1",
          output_lots: [{ lot_id: "lot-does-not-exist", quantity: 1 }],
        },
      ],
      wake_at_ms: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // At t=0 nothing has arrived yet: a business code, not an invalid decision.
    expect(result.observation?.previous_results.map((r) => r.code)).toEqual(["UNKNOWN_ORDER"]);
    expect(result.observation?.previous_results[0]?.ok).toBe(false);
  });
});

describe("game replay file", () => {
  const meta = {
    benchmark_version: "0.3.0-human",
    order_stream: {
      visibility: "public" as const,
      seed: EASY_STREAM.seed,
      generator_version: EASY_STREAM.generator_version,
    },
  };

  it("matches the host replay shape the site reduces over", () => {
    const session = playEasySession();
    const file = session.replayFile(meta);

    expect(Object.keys(file).sort()).toEqual(["events", "header"]);
    expect(Object.keys(file.header).sort()).toEqual([
      "benchmark_version",
      "clock_mode",
      "engine_version",
      "order_stream",
      "protocol_version",
      "replay_kind",
      "replay_schema_version",
      "scenario_hash",
      "scenario_id",
    ]);
    expect(file.header.replay_schema_version).toBe("1");
    expect(file.header.protocol_version).toBe("0.3.0-web");
    expect(file.header.clock_mode).toBe("paused_code");
    expect(file.header.replay_kind).toBe("human");
    expect(file.header.engine_version).toBe(GAME_ENGINE_VERSION);
    expect(file.header.benchmark_version).toBe("0.3.0-human");
    expect(file.header.scenario_id).toBe(CONFIG.scenario_id);
    expect(file.header.scenario_hash).toBe(scenarioHashFor(CONFIG));
    expect(file.header.order_stream).toEqual(meta.order_stream);
    expect(file.events).toEqual([...session.events]);
  });

  it("round-trips through JSON with the host's serialization", () => {
    const session = playEasySession();
    const file = session.replayFile(meta);
    const text = serializeReplayFile(file);

    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(file);
    const parsed = JSON.parse(text) as ReturnType<typeof session.replayFile>;
    for (const event of parsed.events) {
      expect(Object.keys(event).sort()).toEqual(["at_ms", "payload", "seq", "state_version", "type"]);
    }
    expect(parsed.events[0]?.seq).toBe(1);
    expect(parsed.events[parsed.events.length - 1]?.type).toBe("run_finished");
  });

  it("produces the same header for a kernel run and a human run", () => {
    const idle: ControllerModule = { init() {}, decide: () => ({ actions: [], wake_at_ms: null }) };
    const run = runScenario({ config: CONFIG, orderStream: ORDERS, controller: idle, policy_seed: 1 });
    const fromKernel = buildReplayFile(CONFIG, meta, run.events);
    const fromGame = playEasySession().replayFile(meta);

    expect(Object.keys(fromKernel.header)).toEqual(Object.keys(fromGame.header));
    expect(fromKernel.header).toEqual(fromGame.header);
    expect(fromKernel.header.replay_kind).toBe("human");
    // A scored practice run is relabeled without touching anything else.
    expect(buildReplayFile(CONFIG, { ...meta, replay_kind: "practice" }, run.events).header.replay_kind).toBe(
      "practice",
    );
  });
});

describe("game lot helpers", () => {
  const lot = (id: string, item_id: string, quantity: number, produced_at_ms: number): Lot => ({
    id,
    item_id,
    quantity,
    produced_at_ms,
    task_id: "task-x",
  });

  const inventory: Lot[] = [
    lot("lot-3", "fries", 2, 3_000),
    lot("lot-1", "fries", 5, 1_000),
    lot("lot-2", "fries", 1, 2_000),
    lot("lot-9", "bun", 4, 500),
  ];

  it("orders lots earliest-production-first", () => {
    expect(planLots(inventory, []).lots).toEqual([]);
    const plan = planLots(inventory, [{ item_id: "fries", quantity: 4 }]);
    expect(plan.complete).toBe(true);
    expect(plan.missing).toEqual([]);
    // Greedy FEFO: the oldest lot covers the whole line when it can.
    expect(plan.lots).toEqual([{ lot_id: "lot-1", quantity: 4 }]);
    const spill = planLots(inventory, [{ item_id: "fries", quantity: 7 }]);
    expect(spill.lots).toEqual([
      { lot_id: "lot-1", quantity: 5 },
      { lot_id: "lot-2", quantity: 1 },
      { lot_id: "lot-3", quantity: 1 },
    ]);
  });

  it("reports what it cannot cover", () => {
    const plan = planLots(inventory, [{ item_id: "fries", quantity: 99 }]);
    expect(plan.complete).toBe(false);
    expect(plan.missing).toEqual([{ item_id: "fries", quantity: 91 }]);
    expect(plan.lots).toEqual([
      { lot_id: "lot-1", quantity: 5 },
      { lot_id: "lot-2", quantity: 1 },
      { lot_id: "lot-3", quantity: 2 },
    ]);
  });

  it("does not let two actions of one decision claim the same lot", () => {
    const first = planLots(inventory, [{ item_id: "fries", quantity: 6 }]);
    expect(first.lots).toEqual([
      { lot_id: "lot-1", quantity: 5 },
      { lot_id: "lot-2", quantity: 1 },
    ]);
    const second = planLots(inventory, [{ item_id: "fries", quantity: 1 }], first.reserved);
    expect(second.lots).toEqual([{ lot_id: "lot-3", quantity: 1 }]);
    expect(second.complete).toBe(true);
    const third = planLots(inventory, [{ item_id: "fries", quantity: 2 }], second.reserved);
    expect(third.complete).toBe(false);
    expect(third.missing).toEqual([{ item_id: "fries", quantity: 1 }]);
  });

  it("aggregates repeated demand lines", () => {
    const plan = planLots(inventory, [
      { item_id: "fries", quantity: 2 },
      { item_id: "fries", quantity: 2 },
    ]);
    expect(plan.lots).toEqual([{ lot_id: "lot-1", quantity: 4 }]);
  });

  it("plans a start action from produced inputs only", () => {
    const recipe = CONFIG.recipes.find((r) => r.id === "r.pack_combo_box") as Recipe;
    const stock: Lot[] = [
      lot("lot-a", "it.sandwich_base", 2, 1_000),
      lot("lot-b", "it.fries_fried", 4, 2_000),
    ];

    const one = planStartInputs(stock, recipe, 1, PRODUCED);
    expect(one.complete).toBe(true);
    expect(one.lots).toEqual([
      { lot_id: "lot-a", quantity: 1 },
      { lot_id: "lot-b", quantity: 1 },
    ]);

    const two = planStartInputs(stock, recipe, 2, PRODUCED);
    expect(two.lots).toEqual([
      { lot_id: "lot-a", quantity: 2 },
      { lot_id: "lot-b", quantity: 2 },
    ]);

    const three = planStartInputs(stock, recipe, 3, PRODUCED);
    expect(three.complete).toBe(false);
    expect(three.missing).toEqual([{ item_id: "it.sandwich_base", quantity: 1 }]);
    // Raw inputs never ask for a lot: grill_chicken is all chicken_raw.
    const rawRecipe = CONFIG.recipes.find((r) => r.id === "r.grill_chicken") as Recipe;
    expect(planStartInputs([], rawRecipe, 3, PRODUCED)).toEqual({
      lots: [],
      missing: [],
      complete: true,
      reserved: new Map(),
    });
  });

  it("plans a delivery from the whole order", () => {
    const order: Order = {
      id: "o1",
      arrived_at_ms: 0,
      items: [
        { item_id: "fries", quantity: 3 },
        { item_id: "bun", quantity: 1 },
      ] as ItemQty[],
      value_minor: 900,
    };
    const plan = planDeliverOutputs(inventory, order);
    expect(plan.complete).toBe(true);
    // FEFO runs across items too: the bun was produced before the fries.
    expect(plan.lots).toEqual([
      { lot_id: "lot-9", quantity: 1 },
      { lot_id: "lot-1", quantity: 3 },
    ]);

    const partial = planDeliverOutputs(inventory, { ...order, items: [{ item_id: "fries", quantity: 12 }] });
    expect(partial.complete).toBe(false);
  });

  it("lists the produced items of the kitchen", () => {
    expect([...PRODUCED].sort()).toEqual([
      "it.baked_bun",
      "it.chicken_fried",
      "it.chicken_grilled",
      "it.crispy_base",
      "it.fries_fried",
      "it.sandwich_base",
      "p.combo_box",
      "p.crispy_sandwich",
      "p.fries_box",
      "p.grilled_sandwich",
    ]);
  });

  it("leaves the observation untouched", () => {
    const observation: Observation = {
      now_ms: 0,
      state_version: 0,
      final: false,
      orders: [],
      inventory: [...inventory],
      running_tasks: [],
      stations: [],
      revenue_minor: 0,
      previous_results: [],
      previous_wake_result: null,
      pending_wake_at_ms: null,
    };
    const snapshot = JSON.stringify(observation);
    planLots(observation.inventory, [{ item_id: "fries", quantity: 2 }]);
    expect(JSON.stringify(observation)).toBe(snapshot);
  });
});