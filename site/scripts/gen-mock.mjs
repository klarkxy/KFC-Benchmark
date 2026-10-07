/**
 * Generates the demo results tree under site/public/results/.
 *
 * Plain Node, zero dependencies, fully deterministic (seeded PRNG) so the
 * committed mock artifacts are reproducible. Run once and commit the output:
 *
 *     node site/scripts/gen-mock.mjs
 *
 * The generated files match the @kitchensched/contracts shapes:
 *   results/index.json                       ResultsIndex
 *   results/<ver>/leaderboard.json           LeaderboardFile
 *   results/<ver>/runs/<run_id>.json         RunRecord
 *   results/<ver>/runs/replays/<run_id>.json ReplayFile  (path in RunRecord.replay)
 *
 * The event stream is internally consistent: every order_delivered references
 * an order that arrived earlier, consumed lots are real produced lots, and
 * revenue_minor accumulates exactly into run_finished.revenue_minor.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(HERE, "..", "public", "results");
const BENCHMARK_VERSION = "demo-v1";
const ENGINE_VERSION = "0.3.0";
const PROTOCOL_VERSION = "0.3.0-web";
const REPLAY_SCHEMA_VERSION = "1";

const ITEMS = [
  { id: "raw_chicken", name: "生鸡排", supply: "unlimited_raw", orderable: false, price_minor: 0 },
  { id: "raw_cola", name: "可乐原浆", supply: "unlimited_raw", orderable: false, price_minor: 0 },
  { id: "fries", name: "薯条", supply: "produced", orderable: true, price_minor: 450 },
  { id: "patty", name: "烤鸡排", supply: "produced", orderable: true, price_minor: 900 },
  { id: "burger", name: "汉堡", supply: "produced", orderable: true, price_minor: 1500 },
  { id: "cola", name: "可乐", supply: "produced", orderable: true, price_minor: 300 },
];

const RECIPES = [
  {
    id: "r_fry",
    name: "炸薯条",
    inputs: [{ item_id: "raw_chicken", quantity: 1 }],
    outputs: [{ item_id: "fries", quantity: 2 }],
    stations: [
      { station_id: "fry_1", duration_ms: 6000, max_batches: 2 },
      { station_id: "fry_2", duration_ms: 6000, max_batches: 2 },
    ],
  },
  {
    id: "r_patty",
    name: "烤鸡排",
    inputs: [{ item_id: "raw_chicken", quantity: 1 }],
    outputs: [{ item_id: "patty", quantity: 1 }],
    stations: [
      { station_id: "prep_a", duration_ms: 4000, max_batches: 2 },
      { station_id: "prep_b", duration_ms: 4000, max_batches: 2 },
    ],
  },
  {
    id: "r_burger",
    name: "组装汉堡",
    inputs: [{ item_id: "raw_chicken", quantity: 1 }],
    outputs: [{ item_id: "burger", quantity: 1 }],
    stations: [
      { station_id: "assemble_1", duration_ms: 3000, max_batches: 2 },
      { station_id: "assemble_2", duration_ms: 3000, max_batches: 2 },
    ],
  },
  {
    id: "r_cola",
    name: "倒可乐",
    inputs: [{ item_id: "raw_cola", quantity: 1 }],
    outputs: [{ item_id: "cola", quantity: 1 }],
    stations: [
      { station_id: "prep_a", duration_ms: 1000, max_batches: 4 },
      { station_id: "prep_b", duration_ms: 1000, max_batches: 4 },
    ],
  },
];

const STATIONS_BY_DIFFICULTY = {
  easy: ["prep_a", "fry_1", "assemble_1"],
  medium: ["prep_a", "prep_b", "fry_1", "assemble_1"],
  complex: ["prep_a", "prep_b", "fry_1", "fry_2", "assemble_1", "assemble_2"],
};

const ORDERABLE = ITEMS.filter((item) => item.orderable);
const SELLABLE = ORDERABLE.map((item) => item.id);
/** Packing + hand-off time before a stocked order can leave. */
const DELIVERY_LATENCY_MS = 5000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

function recipeById(id) {
  const recipe = RECIPES.find((entry) => entry.id === id);
  if (!recipe) throw new Error(`unknown recipe ${id}`);
  return recipe;
}

function buildOrders(rng, difficulty, count, endAtMs) {
  const orders = [];
  const budget = difficulty === "easy" ? 2 : difficulty === "medium" ? 3 : 4;
  let at = 3000;
  for (let index = 0; index < count; index += 1) {
    const itemCount = 1 + Math.floor(rng() * budget);
    const chosen = [];
    for (let slot = 0; slot < itemCount; slot += 1) {
      const itemId = pick(rng, SELLABLE);
      const existing = chosen.find((entry) => entry.item_id === itemId);
      if (existing) existing.quantity += 1;
      else chosen.push({ item_id: itemId, quantity: 1 });
    }
    const valueMinor = chosen.reduce((sum, entry) => {
      const item = ITEMS.find((candidate) => candidate.id === entry.item_id);
      return sum + (item ? item.price_minor : 0) * entry.quantity;
    }, 0);
    orders.push({
      id: `o-${String(index + 1).padStart(2, "0")}`,
      arrived_at_ms: at,
      items: chosen,
      value_minor: valueMinor,
    });
    at += 9000 + Math.floor(rng() * 9000);
    if (at >= endAtMs - 12000) break;
  }
  return orders;
}

/**
 * Runs a deterministic greedy controller over the virtual kitchen and returns
 * the world events it produced (clock_advanced is merged in afterwards).
 */
function simulate({ seed, difficulty, scenarioId, endAtMs }) {
  const rng = mulberry32(seed);
  const stationIds = STATIONS_BY_DIFFICULTY[difficulty];
  const orders = buildOrders(rng, difficulty, difficulty === "easy" ? 9 : 10, endAtMs);

  const events = [];
  const stations = new Map(stationIds.map((id) => [id, { id, task_id: null }]));
  const tasks = new Map();
  const lots = new Map();
  const pending = [];
  let revenueMinor = 0;
  let deliveredOrders = 0;
  let taskCounter = 0;
  let lotCounter = 0;
  let deliveryCounter = 0;
  let now = 0;
  let totalActions = 0;

  // Payloads are deep-copied: the simulator keeps mutating lots and orders
  // after they are emitted, and the committed stream must stay frozen.
  const emit = (type, payload, atMs) => {
    events.push({ at_ms: atMs, type, payload: structuredClone(payload) });
    totalActions += 1;
  };

  const stockFor = (itemId) => {
    let qty = 0;
    for (const lot of lots.values()) if (lot.item_id === itemId) qty += lot.quantity;
    return qty;
  };

  const availableFor = (itemId) => {
    let qty = stockFor(itemId);
    for (const task of tasks.values()) {
      const recipe = recipeById(task.recipe_id);
      for (const output of recipe.outputs) {
        if (output.item_id === itemId) qty += output.quantity * task.batches;
      }
    }
    return qty;
  };

  const consume = (itemId, quantity) => {
    const consumed = [];
    let remaining = quantity;
    for (const lot of [...lots.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (remaining <= 0) break;
      if (lot.item_id !== itemId || lot.quantity <= 0) continue;
      const take = Math.min(lot.quantity, remaining);
      lot.quantity -= take;
      remaining -= take;
      if (lot.quantity === 0) lots.delete(lot.id);
      consumed.push({ lot_id: lot.id, item_id: lot.item_id, quantity: take });
    }
    if (remaining > 0) throw new Error(`consume overflow for ${itemId}`);
    return consumed;
  };

  /**
   * FIFO: deliver the earliest queued order that is fully stocked and has been
   * waiting long enough. The latency models packing/hand-off, so stock builds
   * up in inventory instead of being consumed the instant it is produced.
   */
  const tryDeliver = () => {
    for (let index = 0; index < pending.length; index += 1) {
      const order = pending[index];
      if (now - order.arrived_at_ms < DELIVERY_LATENCY_MS) continue;
      const satisfiable = order.items.every(
        (entry) => stockFor(entry.item_id) >= entry.quantity,
      );
      if (!satisfiable) continue;
      const consumed = [];
      for (const entry of order.items) {
        consumed.push(...consume(entry.item_id, entry.quantity));
      }
      pending.splice(index, 1);
      revenueMinor += order.value_minor;
      deliveredOrders += 1;
      deliveryCounter += 1;
      emit(
        "order_delivered",
        {
          order_id: order.id,
          delivery_id: `dlv-${String(deliveryCounter).padStart(2, "0")}`,
          at_ms: now,
          consumed,
          value_minor: order.value_minor,
          revenue_minor: revenueMinor,
        },
        now,
      );
      return true;
    }
    return false;
  };

  const tryStart = () => {
    if (pending.length === 0) return false;
    const demand = new Map();
    for (const order of pending) {
      for (const entry of order.items) {
        demand.set(entry.item_id, (demand.get(entry.item_id) ?? 0) + entry.quantity);
      }
    }
    for (const itemId of [...demand.keys()].sort()) {
      const recipe = RECIPES.find((entry) =>
        entry.outputs.some((output) => output.item_id === itemId),
      );
      if (!recipe) continue;
      const output = recipe.outputs.find((entry) => entry.item_id === itemId);
      if (!output) continue;
      const missing = (demand.get(itemId) ?? 0) - availableFor(itemId);
      if (missing <= 0) continue;
      for (const option of recipe.stations) {
        if (!stations.has(option.station_id)) continue;
        const station = stations.get(option.station_id);
        if (!station || station.task_id !== null) continue;
        const batches = Math.max(
          1,
          Math.min(
            Math.ceil(missing / output.quantity),
            option.max_batches,
          ),
        );
        const startedAtMs = now;
        const finishAtMs = now + option.duration_ms * batches;
        taskCounter += 1;
        const task = {
          id: `task-${String(taskCounter).padStart(2, "0")}`,
          recipe_id: recipe.id,
          station_id: option.station_id,
          batches,
          started_at_ms: startedAtMs,
          finish_at_ms: finishAtMs,
        };
        const producedLots = [];
        for (let batch = 0; batch < batches; batch += 1) {
          lotCounter += 1;
          producedLots.push({
            id: `lot-${String(lotCounter).padStart(2, "0")}`,
            item_id: itemId,
            quantity: output.quantity,
            produced_at_ms: finishAtMs,
            task_id: task.id,
          });
        }
        tasks.set(task.id, task);
        station.task_id = task.id;
        emit("task_started", { task }, now);
        return true;
      }
    }
    return false;
  };

  let nextArrival = orders.length > 0 ? orders[0].arrived_at_ms : endAtMs;

  while (now < endAtMs) {
    if (tryDeliver()) continue;
    if (tryStart()) continue;

    const running = [...tasks.values()];
    const nextFinish = running.reduce(
      (min, task) => Math.min(min, task.finish_at_ms),
      Number.POSITIVE_INFINITY,
    );
    // Wake up for the next arrival, task completion, or the moment a fully
    // stocked order ages past the delivery latency. Orders blocked by stock
    // are excluded, otherwise their elapsed eligibility time would pin the
    // cursor at `now` and the loop could never advance.
    const nextDeliveryEligible = pending.reduce((min, order) => {
      const stocked = order.items.every(
        (entry) => stockFor(entry.item_id) >= entry.quantity,
      );
      if (!stocked) return min;
      return Math.min(min, order.arrived_at_ms + DELIVERY_LATENCY_MS);
    }, Number.POSITIVE_INFINITY);
    const nextStep = Math.min(nextArrival, nextFinish, nextDeliveryEligible);
    if (!Number.isFinite(nextStep) || nextStep > endAtMs) break;
    if (nextStep <= now) break;
    now = nextStep;

    if (now >= nextArrival) {
      const arriving = orders.find((order) => order.arrived_at_ms <= now && !order.emitted);
      if (arriving) {
        arriving.emitted = true;
        pending.push(arriving);
        emit("order_arrived", { order: arriving }, now);
      }
      const upcoming = orders.filter((order) => !order.emitted);
      nextArrival =
        upcoming.length > 0 ? upcoming[0].arrived_at_ms : Number.POSITIVE_INFINITY;
    }

    for (const task of [...tasks.values()]) {
      if (task.finish_at_ms > now) continue;
      tasks.delete(task.id);
      const station = stations.get(task.station_id);
      if (station && station.task_id === task.id) station.task_id = null;
      const recipe = recipeById(task.recipe_id);
      const produced = [];
      for (let batch = 0; batch < task.batches; batch += 1) {
        lotCounter += 1;
        const lot = {
          id: `lot-${String(lotCounter).padStart(2, "0")}`,
          item_id: recipe.outputs[0].item_id,
          quantity: recipe.outputs[0].quantity,
          produced_at_ms: task.finish_at_ms,
          task_id: task.id,
        };
        lots.set(lot.id, lot);
        produced.push(lot);
      }
      emit("task_completed", { task, lots: produced }, now);
    }
  }

  const stateHash = sha256(
    JSON.stringify({
      revenue_minor: revenueMinor,
      delivered_orders: deliveredOrders,
      orders: orders.map((order) => [order.id, order.value_minor]),
      lots: [...lots.keys()],
      scenario_id: scenarioId,
    }),
  );

  return {
    events: mergeClockEvents(events, endAtMs),
    endAtMs,
    revenueMinor,
    deliveredOrders,
    stateHash,
    totalActions,
    orders: orders.map(({ id, arrived_at_ms, items, value_minor }) => ({
      id,
      arrived_at_ms,
      items,
      value_minor,
    })),
  };
}

/**
 * Sparsely records clock jumps into the gaps of the world event stream.
 * Every recipe here consumes only unlimited_raw inputs, so the site can
 * rebuild inventory from task_completed lots and delivery consumption alone.
 */
function mergeClockEvents(events, endAtMs) {
  const merged = [];
  let previousMs = 0;
  for (const event of events) {
    const gap = event.at_ms - previousMs;
    if (gap >= 9000) {
      merged.push({
        at_ms: previousMs + Math.floor(gap / 2),
        type: "clock_advanced",
        payload: { from_ms: previousMs, to_ms: event.at_ms },
      });
    }
    merged.push(event);
    previousMs = event.at_ms;
  }
  if (endAtMs - previousMs >= 9000) {
    merged.push({
      at_ms: previousMs + Math.floor((endAtMs - previousMs) / 2),
      type: "clock_advanced",
      payload: { from_ms: previousMs, to_ms: endAtMs },
    });
  }
  return merged;
}

function buildRun({ runId, difficulty, modelLabel, generation, seed, endAtMs }) {
  const scenarioId = `demo-${difficulty}-rush`;
  const scenarioVersion = "1.0.0";
  const scenarioHash = sha256(`scenario:${scenarioId}:${scenarioVersion}:${difficulty}`);
  const sim = simulate({ seed, difficulty, scenarioId, endAtMs });

  const events = sim.events.map((event, index) => ({
    seq: index + 1,
    at_ms: event.at_ms,
    type: event.type,
    payload: event.payload,
    state_version: index + 1,
  }));

  const finishedAtMs = endAtMs;
  const finishedIndex = events.length;
  events.push({
    seq: finishedIndex + 1,
    at_ms: finishedAtMs,
    type: "run_finished",
    payload: {
      status: "completed",
      score_minor: sim.revenueMinor,
      revenue_minor: sim.revenueMinor,
      delivered_orders: sim.deliveredOrders,
      state_hash: sim.stateHash,
    },
    state_version: finishedIndex + 1,
  });

  const replayPath = `${BENCHMARK_VERSION}/runs/replays/${runId}.json`;
  const run = {
    run_id: runId,
    benchmark_version: BENCHMARK_VERSION,
    difficulty,
    scenario_id: scenarioId,
    scenario_hash: scenarioHash,
    submission: {
      submission_id: `sub-${modelLabel}-${generation}`,
      source_sha256: sha256(`submission:${modelLabel}:${generation}:${difficulty}`),
      model_label: modelLabel,
      generation,
    },
    result: {
      status: "completed",
      score_minor: sim.revenueMinor,
      revenue_minor: sim.revenueMinor,
      delivered_orders: sim.deliveredOrders,
      failure_code: null,
      final_action_results: [],
      final_wake_result: null,
    },
    state_hash: sim.stateHash,
    replay: replayPath,
    wall: {
      decisions: Math.max(1, Math.round(events.length / 2)),
      total_actions: sim.totalActions,
      duration_ms: 320 + events.length * 7,
    },
    finished_at_iso: "2026-10-05T12:00:00.000Z",
  };

  const replay = {
    header: {
      replay_schema_version: REPLAY_SCHEMA_VERSION,
      engine_version: ENGINE_VERSION,
      protocol_version: PROTOCOL_VERSION,
      benchmark_version: BENCHMARK_VERSION,
      scenario_id: scenarioId,
      scenario_hash: scenarioHash,
      clock_mode: "paused_code",
      replay_kind: "demo",
      order_stream: {
        visibility: "public",
        seed,
        generator_version: "0.3.0",
      },
    },
    events,
  };

  return { run, replay };
}

const RUNS = [
  buildRun({
    runId: "demo-easy-greedy-c1",
    difficulty: "easy",
    modelLabel: "baseline/greedy",
    generation: 1,
    seed: 20261005,
    endAtMs: 165000,
  }),
  buildRun({
    runId: "demo-medium-gptx-c1",
    difficulty: "medium",
    modelLabel: "gpt-x",
    generation: 1,
    seed: 20261006,
    endAtMs: 180000,
  }),
];

/**
 * `case_scores` mirrors the full case matrix of the row; the first entry is
 * always the published run above, so mean_score_minor stays consistent with
 * results/<ver>/runs/<run_id>.json. candidate_failed cases score 0, and any
 * infra_failed case blocks publication (mean becomes null).
 */
const LEADERBOARD_ROWS = [
  {
    submission: { submission_id: "sub-baseline-greedy-1", model_label: "baseline/greedy", generation: 1 },
    difficulty: "easy",
    cases: 2,
    completed: 2,
    candidate_failed: 0,
    infra_failed: 0,
    case_scores: [RUNS[0].run.result.score_minor, 10400],
    run_ids: ["demo-easy-greedy-c1", "demo-easy-greedy-c2"],
  },
  {
    submission: { submission_id: "sub-kimi-k3-1", model_label: "kimi-k3", generation: 1 },
    difficulty: "easy",
    cases: 2,
    completed: 1,
    candidate_failed: 1,
    infra_failed: 0,
    case_scores: [6800, 0],
    run_ids: ["demo-easy-kimi-c1", "demo-easy-kimi-c2"],
  },
  {
    submission: { submission_id: "sub-kimi-k3-2", model_label: "kimi-k3", generation: 2 },
    difficulty: "easy",
    cases: 2,
    completed: 2,
    candidate_failed: 0,
    infra_failed: 0,
    case_scores: [11800, 9000],
    run_ids: ["demo-easy-kimi-c1", "demo-easy-kimi-c2"],
  },
  {
    submission: { submission_id: "sub-gpt-x-1", model_label: "gpt-x", generation: 1 },
    difficulty: "medium",
    cases: 2,
    completed: 2,
    candidate_failed: 0,
    infra_failed: 0,
    case_scores: [RUNS[1].run.result.score_minor, 16200],
    run_ids: ["demo-medium-gptx-c1", "demo-medium-gptx-c2"],
  },
  {
    submission: { submission_id: "sub-kimi-k3-3", model_label: "kimi-k3", generation: 1 },
    difficulty: "medium",
    cases: 2,
    completed: 1,
    candidate_failed: 1,
    infra_failed: 0,
    case_scores: [11300, 0],
    run_ids: ["demo-medium-kimi-c1", "demo-medium-kimi-c2"],
  },
  {
    submission: { submission_id: "sub-gpt-x-2", model_label: "gpt-x", generation: 1 },
    difficulty: "complex",
    cases: 2,
    completed: 1,
    candidate_failed: 0,
    infra_failed: 1,
    case_scores: [24800, null],
    run_ids: ["demo-complex-gptx-c1", "demo-complex-gptx-c2"],
  },
];

for (const row of LEADERBOARD_ROWS) {
  row.submission.source_sha256 =
    row.submission.source_sha256 ??
    sha256(`submission:${row.submission.model_label}:${row.submission.generation}:${row.difficulty}`);
  if (row.case_scores.length !== row.cases) {
    throw new Error(`row ${row.submission.submission_id}: cases mismatch`);
  }
  if (row.completed + row.candidate_failed + row.infra_failed !== row.cases) {
    throw new Error(`row ${row.submission.submission_id}: status counts mismatch`);
  }
  row.mean_score_minor =
    row.infra_failed > 0
      ? null
      : Math.round(
          row.case_scores.reduce((sum, score) => sum + (score ?? 0), 0) / row.cases,
        );
  delete row.case_scores;
}

const index = {
  versions: [
    {
      benchmark_version: BENCHMARK_VERSION,
      leaderboard: `${BENCHMARK_VERSION}/leaderboard.json`,
      published_at_iso: "2026-10-05T12:05:00.000Z",
    },
  ],
};

const leaderboard = {
  benchmark_version: BENCHMARK_VERSION,
  generated_at_iso: "2026-10-05T12:05:00.000Z",
  engine_version: ENGINE_VERSION,
  protocol_version: PROTOCOL_VERSION,
  rows: LEADERBOARD_ROWS,
};

function writeJson(relativePath, value) {
  const target = join(OUT_ROOT, ...relativePath.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

writeJson("index.json", index);
writeJson(`${BENCHMARK_VERSION}/leaderboard.json`, leaderboard);

for (const { run, replay } of RUNS) {
  writeJson(`${BENCHMARK_VERSION}/runs/${run.run_id}.json`, run);
  writeJson(`${BENCHMARK_VERSION}/runs/replays/${run.run_id}.json`, replay);
  const kinds = new Map();
  for (const event of replay.events) kinds.set(event.type, (kinds.get(event.type) ?? 0) + 1);
  console.log(
    `${run.run_id}: ${replay.events.length} events, ${run.result.delivered_orders} delivered, ` +
      `${run.result.score_minor} credit_minor, kinds=${JSON.stringify(Object.fromEntries(kinds))}`,
  );
}

console.log(`wrote ${OUT_ROOT}`);
