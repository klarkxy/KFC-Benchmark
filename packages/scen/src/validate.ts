/**
 * Scenario loader validation — the subset of doc 02 §12 that applies to the
 * generated `scenarios/` tree, run by the CLI on every file it writes.
 *
 * `validatePublicConfig` checks structural identity, reference integrity, the
 * recipe DAG and the raw/orderable invariants.
 * `validateOrderStream` checks the arrival trajectory and recomputes every
 * order value from the frozen prices.
 *
 * Both return a list of issues; an empty list means valid.
 */

import type { ItemQty, PublicConfig } from "@kitchensched/contracts";

import { MAX_BATCHES_CAP } from "./kitchens.js";
import { materializeOrders, type OrderStreamFile } from "./stream.js";

export interface ValidationIssue {
  /** Stable machine-readable reason; tests assert on these. */
  code: string;
  /** JSON-pointer-ish location, e.g. `recipes[3].station_options[0].station_id`. */
  path: string;
  message: string;
}

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const MAX_INT = 9_007_199_254_740_991;

export const EXPECTED_RULES = {
  clock: "paused_code",
  settlement: "whole_order",
  batch_timing: "fixed_within_capacity",
  finish_at_deadline_counts: true,
  delivery_duration_ms: 0,
  cancellation: "unsupported",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_INT;
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_INT;
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function push(issues: ValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message });
}

/* ------------------------------------------------------------------------ */
/* PublicConfig                                                             */
/* ------------------------------------------------------------------------ */

export function validatePublicConfig(config: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(config)) {
    push(issues, "config.not_object", "$", "config must be a JSON object");
    return issues;
  }

  /* --- scalar envelope ------------------------------------------------- */
  if (config["protocol_version"] !== "0.3.0-web") {
    push(issues, "config.protocol_version", "protocol_version", "must be \"0.3.0-web\"");
  }
  if (!isValidId(config["scenario_id"])) {
    push(issues, "config.scenario_id", "scenario_id", "must match the id pattern");
  }
  if (typeof config["scenario_version"] !== "string" || config["scenario_version"].length === 0) {
    push(issues, "config.scenario_version", "scenario_version", "must be a non-empty string");
  }
  if (config["difficulty"] !== "easy" && config["difficulty"] !== "medium" && config["difficulty"] !== "complex") {
    push(issues, "config.difficulty", "difficulty", "must be easy | medium | complex");
  }
  if (!isPosInt(config["end_at_ms"])) {
    push(issues, "config.end_at_ms", "end_at_ms", "must be a positive safe integer within 0..2^53-1");
  }
  if (config["currency_unit"] !== "credit_minor") {
    push(issues, "config.currency_unit", "currency_unit", "must be \"credit_minor\"");
  }
  if (config["currency_scale"] !== 100) {
    push(issues, "config.currency_scale", "currency_scale", "must be 100");
  }

  /* --- rules ----------------------------------------------------------- */
  if (!isRecord(config["rules"])) {
    push(issues, "config.rules", "rules", "rules must be an object");
  } else {
    const rules = config["rules"];
    for (const [key, expected] of Object.entries(EXPECTED_RULES)) {
      if (rules[key] !== expected) {
        push(issues, "config.rules", `rules.${key}`, `must be ${JSON.stringify(expected)} for protocol 0.3.0-web`);
      }
    }
  }

  /* --- limits ---------------------------------------------------------- */
  const LIMIT_FIELDS = [
    "init_wall_ms",
    "decision_wall_ms",
    "total_cpu_ms",
    "memory_mib",
    "max_decisions",
    "max_actions_per_decision",
    "max_total_actions",
    "min_wake_delay_ms",
    "max_message_bytes",
    "max_stderr_bytes",
    "max_pids",
    "max_writable_mib",
    "max_orders_per_run",
  ] as const;
  if (!isRecord(config["limits"])) {
    push(issues, "config.limits", "limits", "limits must be an object");
  } else {
    const limits = config["limits"];
    for (const field of LIMIT_FIELDS) {
      if (!isPosInt(limits[field])) {
        push(issues, "config.limits", `limits.${field}`, "must be a positive safe integer");
      }
    }
    if (isPosInt(limits["max_actions_per_decision"]) && (limits["max_actions_per_decision"] as number) > 1024) {
      push(issues, "config.limits", "limits.max_actions_per_decision", "schema caps this at 1024");
    }
    if (isPosInt(limits["max_orders_per_run"]) && (limits["max_orders_per_run"] as number) > 1024) {
      push(issues, "config.limits", "limits.max_orders_per_run", "schema caps this at 1024");
    }
  }

  /* --- collections ----------------------------------------------------- */
  const items = config["items"];
  const recipes = config["recipes"];
  const stations = config["stations"];
  if (!Array.isArray(items) || items.length === 0) {
    push(issues, "config.items", "items", "items must be a non-empty array");
  }
  if (!Array.isArray(recipes) || recipes.length === 0) {
    push(issues, "config.recipes", "recipes", "recipes must be a non-empty array");
  }
  if (!Array.isArray(stations) || stations.length === 0) {
    push(issues, "config.stations", "stations", "stations must be a non-empty array");
  }
  if (!Array.isArray(items) || !Array.isArray(recipes) || !Array.isArray(stations)) {
    return issues;
  }

  /* --- station ids ----------------------------------------------------- */
  const stationIds = new Set<string>();
  stations.forEach((station, i) => {
    if (!isRecord(station)) {
      push(issues, "config.station_shape", `stations[${i}]`, "station must be an object");
      return;
    }
    const id = station["id"];
    if (!isValidId(id)) {
      push(issues, "config.id_pattern", `stations[${i}].id`, `invalid station id: ${String(id)}`);
      return;
    }
    if (stationIds.has(id)) {
      push(issues, "config.duplicate_id", `stations[${i}].id`, `duplicate station id: ${id}`);
      return;
    }
    stationIds.add(id);
    if (typeof station["kind"] !== "string" || station["kind"].length === 0) {
      push(issues, "config.station_shape", `stations[${i}].kind`, "kind must be a non-empty string");
    }
    if (typeof station["name"] !== "string" || station["name"].length === 0) {
      push(issues, "config.station_shape", `stations[${i}].name`, "name must be a non-empty string");
    }
  });

  /* --- items ----------------------------------------------------------- */
  const supplyById = new Map<string, string>();
  const orderableIds = new Set<string>();
  items.forEach((item, i) => {
    if (!isRecord(item)) {
      push(issues, "config.item_shape", `items[${i}]`, "item must be an object");
      return;
    }
    const id = item["id"];
    if (!isValidId(id)) {
      push(issues, "config.id_pattern", `items[${i}].id`, `invalid item id: ${String(id)}`);
      return;
    }
    if (supplyById.has(id)) {
      push(issues, "config.duplicate_id", `items[${i}].id`, `duplicate item id: ${id}`);
      return;
    }
    const supply = item["supply"];
    if (supply !== "unlimited_raw" && supply !== "produced") {
      push(issues, "config.item_shape", `items[${i}].supply`, "supply must be unlimited_raw | produced");
      return;
    }
    supplyById.set(id, supply);

    const orderable = item["orderable"];
    if (typeof orderable !== "boolean") {
      push(issues, "config.item_shape", `items[${i}].orderable`, "orderable must be a boolean");
      return;
    }
    if (!isNonNegInt(item["price_minor"])) {
      push(issues, "config.item_shape", `items[${i}].price_minor`, "price_minor must be a non-negative safe integer");
      return;
    }
    if (orderable) {
      if ((item["price_minor"] as number) <= 0) {
        push(issues, "config.price_invariant", `items[${i}].price_minor`, "orderable items must have price_minor > 0");
      }
      orderableIds.add(id);
    } else if ((item["price_minor"] as number) > 0) {
      push(issues, "config.price_invariant", `items[${i}].price_minor`, "non-orderable items must have price_minor 0");
    }
    if (supply === "unlimited_raw" && orderable) {
      push(issues, "config.raw_orderable", `items[${i}].orderable`, "unlimited_raw items can never be orderable");
    }
  });

  /* --- recipes --------------------------------------------------------- */
  // produced input -> produced output edges, for reachability and acyclicity
  const edges: { from: string; to: string; recipeId: string }[] = [];
  const seenRecipeIds = new Set<string>();

  recipes.forEach((recipe, i) => {
    const base = `recipes[${i}]`;
    if (!isRecord(recipe)) {
      push(issues, "config.recipe_shape", base, "recipe must be an object");
      return;
    }
    const recipeId = recipe["id"];
    if (!isValidId(recipeId)) {
      push(issues, "config.id_pattern", `${base}.id`, `invalid recipe id: ${String(recipeId)}`);
      return;
    }
    if (seenRecipeIds.has(recipeId)) {
      push(issues, "config.duplicate_id", `${base}.id`, `duplicate recipe id: ${recipeId}`);
      return;
    }
    seenRecipeIds.add(recipeId);
    if (typeof recipe["name"] !== "string" || recipe["name"].length === 0) {
      push(issues, "config.recipe_shape", `${base}.name`, "name must be a non-empty string");
    }

    const inputs = recipe["inputs"];
    const outputs = recipe["outputs"];
    const options = recipe["station_options"];

    if (!Array.isArray(inputs) || inputs.length === 0) {
      push(issues, "config.recipe_shape", `${base}.inputs`, "inputs must be a non-empty array");
    }
    if (!Array.isArray(outputs) || outputs.length === 0) {
      push(issues, "config.recipe_shape", `${base}.outputs`, "outputs must be a non-empty array");
    }
    if (!Array.isArray(options) || options.length === 0) {
      push(issues, "config.recipe_shape", `${base}.station_options`, "station_options must be a non-empty array");
    }

    const seenInputs = new Set<string>();
    const producedInputs: string[] = [];
    if (Array.isArray(inputs)) {
      inputs.forEach((entry, j) => {
        const path = `${base}.inputs[${j}]`;
        if (!isRecord(entry)) {
          push(issues, "config.item_qty_shape", path, "must be an object");
          return;
        }
        const itemId = entry["item_id"];
        if (!isValidId(itemId)) {
          push(issues, "config.id_pattern", `${path}.item_id`, `invalid item id: ${String(itemId)}`);
          return;
        }
        if (!supplyById.has(itemId)) {
          push(issues, "config.unknown_item_ref", `${path}.item_id`, `no such item: ${itemId}`);
          return;
        }
        if (seenInputs.has(itemId)) {
          push(issues, "config.duplicate_input_item", `${path}.item_id`, `duplicate input item ${itemId}; merge it in the config`);
          return;
        }
        seenInputs.add(itemId);
        if (!isPosInt(entry["quantity"])) {
          push(issues, "config.item_qty_shape", `${path}.quantity`, "quantity must be a positive safe integer");
        }
        if (supplyById.get(itemId) === "produced") producedInputs.push(itemId);
      });
    }

    if (Array.isArray(outputs)) {
      outputs.forEach((entry, j) => {
        const path = `${base}.outputs[${j}]`;
        if (!isRecord(entry)) {
          push(issues, "config.item_qty_shape", path, "must be an object");
          return;
        }
        const itemId = entry["item_id"];
        if (!isValidId(itemId)) {
          push(issues, "config.id_pattern", `${path}.item_id`, `invalid item id: ${String(itemId)}`);
          return;
        }
        const supply = supplyById.get(itemId);
        if (supply === undefined) {
          push(issues, "config.unknown_item_ref", `${path}.item_id`, `no such item: ${itemId}`);
          return;
        }
        if (supply === "unlimited_raw") {
          push(issues, "config.raw_recipe_output", `${path}.item_id`, "unlimited_raw items can never be recipe outputs");
          return;
        }
        if (!isPosInt(entry["quantity"])) {
          push(issues, "config.item_qty_shape", `${path}.quantity`, "quantity must be a positive safe integer");
        }
      });

      // produced input -> produced output edges for this recipe
      for (const from of producedInputs) {
        for (const entry of outputs) {
          if (!isRecord(entry)) continue;
          const to = entry["item_id"];
          if (typeof to === "string" && supplyById.get(to) === "produced") {
            edges.push({ from, to, recipeId: String(recipeId) });
          }
        }
      }
    }

    if (Array.isArray(options)) {
      const seenStations = new Set<string>();
      options.forEach((option, j) => {
        const path = `${base}.station_options[${j}]`;
        if (!isRecord(option)) {
          push(issues, "config.recipe_shape", path, "station option must be an object");
          return;
        }
        const stationId = option["station_id"];
        if (!isValidId(stationId)) {
          push(issues, "config.id_pattern", `${path}.station_id`, `invalid station id: ${String(stationId)}`);
          return;
        }
        if (!stationIds.has(stationId)) {
          push(issues, "config.unknown_station_ref", `${path}.station_id`, `no such station: ${stationId}`);
          return;
        }
        if (seenStations.has(stationId)) {
          push(issues, "config.duplicate_station_option", `${path}.station_id`, `duplicate station ${stationId} in one recipe`);
          return;
        }
        seenStations.add(stationId);
        if (!isPosInt(option["duration_ms"])) {
          push(issues, "config.duration_ms", `${path}.duration_ms`, "duration_ms must be a positive safe integer (> 0)");
        }
        const maxBatches = option["max_batches"];
        if (!isPosInt(maxBatches) || (maxBatches as number) > MAX_BATCHES_CAP) {
          push(issues, "config.max_batches", `${path}.max_batches`, `max_batches must be an integer in 1..${MAX_BATCHES_CAP}`);
        }
      });
    }
  });

  /* --- acyclicity ------------------------------------------------------ */
  const cycle = findCycle(edges);
  if (cycle) {
    push(
      issues,
      "config.recipe_cycle",
      "recipes",
      `recipe graph has a cycle: ${cycle.map((r) => r.recipeId).join(" -> ")}`,
    );
  }

  /* --- reachability from unlimited_raw --------------------------------- */
  // A recipe becomes available once every one of its inputs is either raw or
  // already producible; its outputs then become producible. Raw-only recipes
  // (no produced input) therefore contribute no edges above but must still
  // unlock their outputs here.
  const producible = new Set<string>();
  for (const [id, supply] of supplyById) {
    if (supply === "unlimited_raw") producible.add(id);
  }
  const recipeInputs: { inputs: string[]; outputs: string[] }[] = [];
  for (const recipe of recipes) {
    if (!isRecord(recipe)) continue;
    const recipeId = recipe["id"];
    if (typeof recipeId !== "string" || !seenRecipeIds.has(recipeId)) continue;
    const inputs = Array.isArray(recipe["inputs"])
      ? recipe["inputs"]
          .filter(isRecord)
          .map((q) => q["item_id"])
          .filter((x): x is string => typeof x === "string")
      : [];
    const outputs = Array.isArray(recipe["outputs"])
      ? recipe["outputs"]
          .filter(isRecord)
          .map((q) => q["item_id"])
          .filter((x): x is string => typeof x === "string")
      : [];
    if (inputs.length === 0 || outputs.length === 0) continue;
    recipeInputs.push({ inputs, outputs });
  }

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const recipe of recipeInputs) {
      if (!recipe.inputs.every((id) => producible.has(id))) continue;
      for (const out of recipe.outputs) {
        if (supplyById.get(out) === "produced" && !producible.has(out)) {
          producible.add(out);
          progressed = true;
        }
      }
    }
  }

  for (const id of [...orderableIds].sort()) {
    if (!producible.has(id)) {
      push(issues, "config.unreachable_item", `items.${id}`, `orderable item ${id} is not reachable from unlimited_raw`);
    }
  }

  /* --- amount overflow ------------------------------------------------- */
  items.forEach((item, i) => {
    if (!isRecord(item)) return;
    const price = item["price_minor"];
    if (!isNonNegInt(price)) return;
    if ((price as number) * MAX_BATCHES_CAP > MAX_INT) {
      push(issues, "config.amount_overflow", `items[${i}].price_minor`, "price * max_batches exceeds 2^53-1");
    }
  });

  return issues;
}

interface GraphEdge {
  from: string;
  to: string;
  recipeId: string;
}

/** Depth-first search returning one cycle, or null when the graph is acyclic. */
function findCycle(edges: readonly GraphEdge[]): GraphEdge[] | null {
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const stack: GraphEdge[] = [];

  const visit = (node: string): GraphEdge[] | null => {
    colour.set(node, GREY);
    const out = adjacency.get(node) ?? [];
    for (const edge of out) {
      const state = colour.get(edge.to) ?? WHITE;
      if (state === GREY) {
        const start = stack.findIndex((e) => e.to === edge.to);
        return [...stack.slice(start < 0 ? 0 : start), edge];
      }
      if (state === WHITE) {
        stack.push(edge);
        const found = visit(edge.to);
        if (found) return found;
        stack.pop();
      }
    }
    colour.set(node, BLACK);
    return null;
  };

  for (const edge of edges) {
    if ((colour.get(edge.from) ?? WHITE) === WHITE) {
      const found = visit(edge.from);
      if (found) return found;
      stack.length = 0;
    }
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* Order stream                                                             */
/* ------------------------------------------------------------------------ */

/**
 * @param config validated config, used to recompute order values.
 */
export function validateOrderStream(config: PublicConfig, stream: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(stream)) {
    push(issues, "stream.not_object", "$", "stream must be a JSON object");
    return issues;
  }

  if (stream["version"] !== "1") {
    push(issues, "stream.version", "version", 'must be "1"');
  }
  if (stream["scenario_id"] !== config.scenario_id) {
    push(issues, "stream.scenario_id", "scenario_id", `must match config ${config.scenario_id}`);
  }
  if (!Number.isSafeInteger(stream["seed"])) {
    push(issues, "stream.seed", "seed", "must be a safe integer");
  }
  if (typeof stream["generator_version"] !== "string" || stream["generator_version"].length === 0) {
    push(issues, "stream.generator_version", "generator_version", "must be a non-empty string");
  }
  if (stream["difficulty"] !== config.difficulty) {
    push(issues, "stream.difficulty", "difficulty", `must match config ${config.difficulty}`);
  }

  const orders = stream["orders"];
  if (!Array.isArray(orders) || orders.length === 0) {
    push(issues, "stream.orders", "orders", "orders must be a non-empty array");
    return issues;
  }

  const prices = new Map<string, number>();
  for (const item of config.items) prices.set(item.id, item.price_minor);

  const endAt = config.end_at_ms;
  const maxOrders = config.limits.max_orders_per_run;

  let previousAt = -1;
  orders.forEach((entry, i) => {
    const path = `orders[${i}]`;
    if (!isRecord(entry)) {
      push(issues, "stream.order_shape", path, "order must be an object");
      return;
    }
    const at = entry["at_ms"];
    if (!isNonNegInt(at)) {
      push(issues, "stream.at_ms", `${path}.at_ms`, "at_ms must be a non-negative safe integer");
      return;
    }
    if (at < previousAt) {
      push(issues, "stream.not_sorted", `${path}.at_ms`, `arrivals must be non-decreasing (${at} after ${previousAt})`);
    }
    previousAt = at;
    if (at >= endAt) {
      push(issues, "stream.at_or_after_deadline", `${path}.at_ms`, `arrival ${at} must be < end_at_ms ${endAt}`);
    }

    const lines = entry["items"];
    if (!Array.isArray(lines) || lines.length === 0) {
      push(issues, "stream.order_shape", `${path}.items`, "items must be a non-empty array");
      return;
    }
    const seen = new Set<string>();
    let valueMinor = 0;
    lines.forEach((line, j) => {
      const linePath = `${path}.items[${j}]`;
      if (!isRecord(line)) {
        push(issues, "stream.order_shape", linePath, "item line must be an object");
        return;
      }
      const itemId = line["item_id"];
      if (!isValidId(itemId)) {
        push(issues, "stream.item_id", `${linePath}.item_id`, `invalid item id: ${String(itemId)}`);
        return;
      }
      if (!prices.has(itemId)) {
        push(issues, "stream.unknown_item", `${linePath}.item_id`, `no such item: ${itemId}`);
        return;
      }
      if (seen.has(itemId)) {
        push(issues, "stream.duplicate_line_item", `${linePath}.item_id`, `duplicate line for ${itemId}`);
        return;
      }
      seen.add(itemId);
      const quantity = line["quantity"];
      if (!isPosInt(quantity)) {
        push(issues, "stream.quantity", `${linePath}.quantity`, "quantity must be a positive safe integer");
        return;
      }
      const price = prices.get(itemId) ?? 0;
      if (price <= 0) {
        push(issues, "stream.not_orderable", `${linePath}.item_id`, `${itemId} has no positive price`);
        return;
      }
      const configured = config.items.find((it) => it.id === itemId);
      if (configured && !configured.orderable) {
        push(issues, "stream.not_orderable", `${linePath}.item_id`, `${itemId} is not orderable`);
        return;
      }
      valueMinor += price * quantity;
      if (!Number.isSafeInteger(valueMinor) || valueMinor > MAX_INT) {
        push(issues, "stream.amount_overflow", linePath, "order value exceeds 2^53-1");
      }
    });
    if (valueMinor <= 0) {
      push(issues, "stream.value_zero", path, "order value must be positive");
    }
  });

  if (orders.length > maxOrders) {
    push(issues, "stream.too_many_orders", "orders", `${orders.length} orders exceeds limits.max_orders_per_run ${maxOrders}`);
  }

  if (issues.length === 0) {
    // Cross-check the host-side recomputation the simulator relies on.
    const materialized = materializeOrders(config, stream as unknown as OrderStreamFile);
    materialized.forEach((order, i) => {
      if (!Number.isSafeInteger(order.value_minor) || order.value_minor <= 0) {
        push(issues, "stream.value_not_recomputable", `orders[${i}]`, `order ${order.id} value is not a positive safe integer`);
      }
    });
  }

  return issues;
}

/** Convenience: both halves at once. */
export function validateScenario(config: unknown, stream: unknown): ValidationIssue[] {
  const configIssues = validatePublicConfig(config);
  if (configIssues.length > 0) return configIssues;
  return validateOrderStream(config as PublicConfig, stream);
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => `  [${i.code}] ${i.path}: ${i.message}`).join("\n");
}

/** Re-exported so tests can build quantity lists without importing stream internals. */
export type { ItemQty };
