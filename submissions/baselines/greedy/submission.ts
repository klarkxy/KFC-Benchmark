import type {
  Action,
  ControllerModule,
  Decision,
  Item,
  ItemQty,
  Lot,
  LotQty,
  Observation,
  PublicConfig,
  Recipe,
  StationOption,
} from "@kitchensched/contracts";

/**
 * Baseline: greedy pull controller.
 *
 * Three rules, in priority order, re-evaluated on every observation:
 *
 *  1. DELIVER. Any pending order that inventory can satisfy exactly is
 *     delivered immediately, highest order value first. Settlement is whole
 *     order and delivery is free, so a finished order left waiting is a loss.
 *  2. PRODUCE. Everything else is demand pull: expand the pending orders
 *     (plus a small prep buffer during the opening window) down through the
 *     recipe DAG into per-item unit counts, then hand every idle station the
 *     most valuable step it can start right now.
 *  3. WAKE. Come back when the next task finishes.
 *
 * Deterministic by construction: no Math.random, no Date, no timers, no
 * wall-clock reads, no hardcoded order trajectory. Only init/decide, both
 * synchronous. Type-only import from the contracts package.
 */

/** Opening window (fraction of the run) during which a prep buffer is aimed for. */
const PREP_WINDOW_FRACTION = 0.2;
/** Units of each product aimed for during that window. */
const PREP_UNITS_PER_PRODUCT = 2;

/* ------------------------------------------------------------------ *
 * Static plan, derived once from PublicConfig in init()
 * ------------------------------------------------------------------ */

interface Plan {
  end_at_ms: number;
  min_wake_delay_ms: number;
  /** item -> the recipe that produces it (first by recipe id). */
  producer: Map<string, Recipe>;
  /** item -> units produced per batch of its recipe. */
  output_qty: Map<string, number>;
  /** recipe id -> its produced (lot-backed) input items. */
  produced_inputs: Map<string, string[]>;
  /** recipe id -> item -> units consumed per batch. */
  input_qty: Map<string, Map<string, number>>;
  /** recipe id -> fastest station option (tie-break on capacity). */
  fastest: Map<string, StationOption>;
  /** item -> milliseconds of production still needed from raw material. */
  chain_ms: Map<string, number>;
  /** item -> how many consumption levels sit above it (orderable products = 0). */
  depth: Map<string, number>;
  /** item -> best downstream product price; the greedy worth of a unit. */
  value: Map<string, number>;
  orderable: string[];
  /** Every recipe, ordered by id so ties resolve deterministically. */
  recipes: Recipe[];
}

function fastestOption(recipe: Recipe): StationOption | null {
  let best: StationOption | null = null;
  for (const option of recipe.station_options) {
    if (best === null || option.duration_ms < best.duration_ms) best = option;
    else if (option.duration_ms === best.duration_ms && option.max_batches > best.max_batches) best = option;
  }
  return best;
}

/** Depth-first walk of the recipe DAG: value/chain length of every item. */
function analyze(config: PublicConfig): Plan {
  const items = new Map<string, Item>(config.items.map((item) => [item.id, item]));
  const is_produced = (item_id: string): boolean => {
    const item = items.get(item_id);
    return item !== undefined && item.supply === "produced";
  };

  const producer = new Map<string, Recipe>();
  const output_qty = new Map<string, number>();
  const produced_inputs = new Map<string, string[]>();
  const input_qty = new Map<string, Map<string, number>>();
  const fastest = new Map<string, StationOption>();
  const recipes = [...config.recipes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const recipe of recipes) {
    const quantities = new Map<string, number>();
    for (const input of recipe.inputs) quantities.set(input.item_id, (quantities.get(input.item_id) ?? 0) + input.quantity);
    input_qty.set(recipe.id, quantities);
    produced_inputs.set(
      recipe.id,
      [...quantities.keys()].filter(is_produced).sort(),
    );
    const option = fastestOption(recipe);
    if (option !== null) fastest.set(recipe.id, option);
    for (const output of recipe.outputs) {
      if (producer.has(output.item_id)) continue;
      producer.set(output.item_id, recipe);
      output_qty.set(output.item_id, output.quantity);
    }
  }

  // chain_ms[item]: production time still owed, ignoring station contention.
  const chain_ms = new Map<string, number>();
  const chainOf = (item_id: string, seen: Set<string>): number => {
    const cached = chain_ms.get(item_id);
    if (cached !== undefined) return cached;
    if (!is_produced(item_id) || seen.has(item_id)) return 0;
    const recipe = producer.get(item_id);
    if (recipe === undefined) return 0;
    const next_seen = new Set(seen);
    next_seen.add(item_id);
    const duration = fastest.get(recipe.id)?.duration_ms ?? 0;
    let lead = 0;
    for (const input_id of produced_inputs.get(recipe.id) ?? []) {
      lead = Math.max(lead, chainOf(input_id, next_seen));
    }
    const total = duration + lead;
    chain_ms.set(item_id, total);
    return total;
  };
  for (const item of config.items) chainOf(item.id, new Set());

  // depth[item]: consumption levels above the item. Expanding needs from the
  // deepest item up keeps every requirement final before it is expanded.
  const consumers = new Map<string, string[]>();
  for (const recipe of recipes) {
    for (const input_id of produced_inputs.get(recipe.id) ?? []) {
      const bucket = consumers.get(input_id);
      if (bucket === undefined) consumers.set(input_id, [recipe.id]);
      else bucket.push(recipe.id);
    }
  }
  const produced_by_recipe = new Map<string, string[]>(
    recipes.map((recipe) => [recipe.id, recipe.outputs.map((output) => output.item_id)]),
  );
  const depth = new Map<string, number>();
  const depthOf = (item_id: string, seen: Set<string>): number => {
    const cached = depth.get(item_id);
    if (cached !== undefined) return cached;
    const above = consumers.get(item_id);
    if (above === undefined || seen.has(item_id)) return 0;
    const next_seen = new Set(seen);
    next_seen.add(item_id);
    let deepest = 0;
    for (const recipe_id of above) {
      for (const output_id of produced_by_recipe.get(recipe_id) ?? []) {
        deepest = Math.max(deepest, 1 + depthOf(output_id, next_seen));
      }
    }
    depth.set(item_id, deepest);
    return deepest;
  };
  for (const item of config.items) depthOf(item.id, new Set());

  // value[item]: the most expensive product the item can still feed.
  const value = new Map<string, number>();
  const orderable = config.items
    .filter((item) => item.orderable && item.price_minor > 0)
    .map((item) => item.id)
    .sort();
  const markValue = (item_id: string, worth: number): void => {
    if ((value.get(item_id) ?? 0) >= worth) return;
    value.set(item_id, worth);
    const recipe = producer.get(item_id);
    if (recipe === undefined) return;
    for (const input_id of produced_inputs.get(recipe.id) ?? []) markValue(input_id, worth);
  };
  for (const item_id of orderable) {
    const worth = items.get(item_id)?.price_minor ?? 0;
    markValue(item_id, worth);
  }

  return {
    end_at_ms: config.end_at_ms,
    min_wake_delay_ms: config.limits.min_wake_delay_ms,
    producer,
    output_qty,
    produced_inputs,
    input_qty,
    fastest,
    chain_ms,
    depth,
    value,
    orderable,
    recipes,
  };
}

/* ------------------------------------------------------------------ *
 * Lot arithmetic
 * ------------------------------------------------------------------ */

/**
 * Mutable view of the observed inventory for one decision. Lots are consumed
 * FIFO (oldest production first); every take is all-or-nothing, matching the
 * kernel's exact-lot-aggregation rule.
 */
class Stock {
  private readonly lots: Lot[];
  private readonly by_item = new Map<string, Lot[]>();
  private readonly totals = new Map<string, number>();

  constructor(lots: readonly Lot[]) {
    this.lots = lots.filter((lot) => lot.quantity > 0).map((lot) => ({ ...lot }));
    for (const lot of this.lots) {
      const bucket = this.by_item.get(lot.item_id);
      if (bucket === undefined) this.by_item.set(lot.item_id, [lot]);
      else bucket.push(lot);
    }
    for (const [item_id, bucket] of this.by_item) {
      bucket.sort(
        (a, b) => a.produced_at_ms - b.produced_at_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      let total = 0;
      for (const lot of bucket) total += lot.quantity;
      this.totals.set(item_id, total);
    }
  }

  available(item_id: string): number {
    return this.totals.get(item_id) ?? 0;
  }

  /** True when every aggregated line fits in the current inventory. */
  covers(lines: ReadonlyMap<string, number>): boolean {
    for (const [item_id, quantity] of lines) {
      if (this.available(item_id) < quantity) return false;
    }
    return true;
  }

  /** Consumes `quantity` of one item, or returns null and changes nothing. */
  take(item_id: string, quantity: number): LotQty[] | null {
    if (quantity <= 0) return [];
    const bucket = this.by_item.get(item_id);
    if (bucket === undefined || this.available(item_id) < quantity) return null;
    const refs: LotQty[] = [];
    let left = quantity;
    for (const lot of bucket) {
      if (left <= 0) break;
      const take = Math.min(lot.quantity, left);
      refs.push({ lot_id: lot.id, quantity: take });
      left -= take;
    }
    if (left > 0) return null;
    for (const ref of refs) {
      for (const lot of bucket) {
        if (lot.id !== ref.lot_id) continue;
        lot.quantity -= ref.quantity;
        break;
      }
    }
    this.totals.set(item_id, this.available(item_id) - quantity);
    return refs;
  }
}

/* ------------------------------------------------------------------ *
 * Controller
 * ------------------------------------------------------------------ */

let plan: Plan | null = null;
let action_seq = 0;

function nextActionId(): string {
  action_seq += 1;
  return `a${action_seq}`;
}

function bump(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** Collapses duplicate lines so per-item accounting stays exact. */
function aggregate(lines: readonly ItemQty[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) bump(totals, line.item_id, line.quantity);
  return totals;
}

interface Job {
  recipe: Recipe;
  station: StationOption;
  batches: number;
  score: number;
}

/** Most valuable step this station can start right now, or null. */
function chooseJob(station_id: string, need: Map<string, number>, stock: Stock, now: number): Job | null {
  const current = plan;
  if (current === null) return null;
  let best: Job | null = null;

  for (const recipe of current.recipes) {
    const option = recipe.station_options.find((candidate) => candidate.station_id === station_id);
    if (option === undefined) continue;
    const finish = now + option.duration_ms;
    if (finish > current.end_at_ms) continue; // would not settle in time

    const outputs = recipe.outputs;
    const output = outputs[0];
    if (output === undefined) continue;
    // `need` is a gross requirement; stock already covers part of it.
    // Never produce past the outstanding shortfall: batches are capped by demand.
    const shortfall = (need.get(output.item_id) ?? 0) - stock.available(output.item_id);
    if (shortfall < output.quantity) continue;
    const useful = Math.floor(shortfall / output.quantity);
    if (useful < 1) continue;

    let feasible = useful;
    for (const item_id of current.produced_inputs.get(recipe.id) ?? []) {
      const per_batch = current.input_qty.get(recipe.id)?.get(item_id) ?? 1;
      feasible = Math.min(feasible, Math.floor(stock.available(item_id) / per_batch));
    }
    const batches = Math.min(option.max_batches, feasible);
    if (batches < 1) continue;

    const score = (current.value.get(output.item_id) ?? 0) * output.quantity * batches;
    if (best === null || score > best.score) {
      best = { recipe, station: option, batches, score };
    }
  }
  return best;
}

const controller: ControllerModule = {
  init(config: PublicConfig) {
    plan = analyze(config);
    action_seq = 0;
  },

  decide(observation: Observation): Decision {
    const current = plan;
    if (current === null) return { actions: [], wake_at_ms: null };

    const now = observation.now_ms;
    const stock = new Stock(observation.inventory);
    const actions: Action[] = [];

    /* -- 1. deliver everything that is exactly satisfiable -------------- */
    const pending = [...observation.orders].sort(
      (a, b) =>
        b.value_minor - a.value_minor ||
        a.arrived_at_ms - b.arrived_at_ms ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const deliverable = new Set<string>();
    for (const order of pending) {
      const lines = aggregate(order.items);
      if (!stock.covers(lines)) continue;
      // covers() already proved the whole order fits, so nothing is rolled back.
      const taken = [...lines].map(([item_id, quantity]) => stock.take(item_id, quantity));
      if (taken.some((refs) => refs === null)) continue;
      deliverable.add(order.id);
      actions.push({
        type: "deliver",
        action_id: nextActionId(),
        order_id: order.id,
        output_lots: taken.flatMap((refs) => refs ?? []),
      });
    }
    if (observation.final) return { actions, wake_at_ms: null };

    /* -- 2. what the kitchen still owes ---------------------------------- */
    const need = new Map<string, number>();
    for (const order of pending) {
      if (deliverable.has(order.id)) continue;
      const lines = aggregate(order.items);
      // Lead time of the whole order; hopeless orders must not eat capacity.
      let lead = 0;
      for (const item_id of lines.keys()) lead = Math.max(lead, current.chain_ms.get(item_id) ?? 0);
      if (now + lead > current.end_at_ms) continue;
      for (const [item_id, quantity] of lines) bump(need, item_id, quantity);
    }
    // Opening window: aim for a small stock of every product so the first
    // arrivals find finished goods instead of an empty pipeline.
    if (now <= Math.floor(current.end_at_ms * PREP_WINDOW_FRACTION)) {
      for (const item_id of current.orderable) bump(need, item_id, PREP_UNITS_PER_PRODUCT);
    }

    // Expand down the recipe DAG, deepest consumers first, so an item's
    // requirement is complete before it turns into input units. Recipes run in
    // whole batches, so a deficit of n units costs ceil(n / per_batch) batches.
    // Expanding adds new items, hence the rounds; every item is expanded once.
    const expanded = new Set<string>();
    for (let round = 0; round < 64; round += 1) {
      const batch = [...need.keys()]
        .filter((item_id) => !expanded.has(item_id))
        .sort((a, b) => (current.depth.get(b) ?? 0) - (current.depth.get(a) ?? 0) || (a < b ? -1 : 1));
      if (batch.length === 0) break;
      for (const item_id of batch) {
        expanded.add(item_id);
        const deficit = (need.get(item_id) ?? 0) - stock.available(item_id);
        if (deficit <= 0) continue;
        const recipe = current.producer.get(item_id);
        if (recipe === undefined) continue;
        const quantities = current.input_qty.get(recipe.id);
        if (quantities === undefined) continue;
        const batches = Math.ceil(deficit / Math.max(1, current.output_qty.get(item_id) ?? 1));
        for (const input_id of current.produced_inputs.get(recipe.id) ?? []) {
          bump(need, input_id, batches * (quantities.get(input_id) ?? 1));
        }
      }
    }

    /* -- 3. put idle stations to work ------------------------------------ */
    let next_event: number | null = null;
    for (const task of observation.running_tasks) {
      next_event = next_event === null ? task.finish_at_ms : Math.min(next_event, task.finish_at_ms);
    }

    for (const station of observation.stations) {
      if (station.task_id !== null) continue;
      const job = chooseJob(station.id, need, stock, now);
      if (job === null) continue;

      const per_batch = current.input_qty.get(job.recipe.id) ?? new Map<string, number>();
      const input_lots: LotQty[] = [];
      let ok = true;
      for (const item_id of current.produced_inputs.get(job.recipe.id) ?? []) {
        const quantity = (per_batch.get(item_id) ?? 1) * job.batches;
        const refs = stock.take(item_id, quantity);
        if (refs === null) {
          ok = false; // unreachable: chooseJob sized the batch from this stock
          break;
        }
        input_lots.push(...refs);
        bump(need, item_id, -quantity);
      }
      if (!ok) continue;
      const output = job.recipe.outputs[0];
      if (output !== undefined) bump(need, output.item_id, -output.quantity * job.batches);

      actions.push({
        type: "start",
        action_id: nextActionId(),
        recipe_id: job.recipe.id,
        station_id: job.station.station_id,
        batches: job.batches,
        input_lots,
      });
      next_event = next_event === null ? now + job.station.duration_ms : Math.min(next_event, now + job.station.duration_ms);
    }

    /* -- 4. wake on the next thing that can change the world -------------- */
    if (next_event === null) return { actions, wake_at_ms: null };
    const clamped = Math.min(next_event, current.end_at_ms);
    const wake_at_ms = clamped >= now + current.min_wake_delay_ms ? clamped : null;
    return { actions, wake_at_ms };
  },
};

export default controller;