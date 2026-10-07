import { isHash } from "./hash.js";
import type {
  ActionCode,
  EventPayloads,
  EventRecord,
  EventType,
  Id,
  Item,
  Lot,
  Order,
  PublicConfig,
  Recipe,
  Task,
  WakeCode,
} from "@kitchensched/contracts";

export interface VerifyResult {
  ok: boolean;
  mismatches: string[];
}

const MAX_MISMATCHES = 64;

/** Codes that are legal business outcomes; anything else is forged. */
const BUSINESS_CODES: ReadonlySet<string> = new Set<ActionCode>([
  "UNKNOWN_RECIPE",
  "UNKNOWN_STATION",
  "INCOMPATIBLE_STATION",
  "STATION_BUSY",
  "INVALID_BATCH",
  "UNKNOWN_LOT",
  "DUPLICATE_LOT",
  "INVALID_INPUT",
  "INSUFFICIENT_INPUT",
  "UNKNOWN_ORDER",
  "INCOMPLETE_ORDER",
  "ALREADY_DELIVERED",
  "ACTION_ID_CONFLICT",
  "DEADLINE_REACHED",
]);

const WAKE_CODES: ReadonlySet<string> = new Set<WakeCode>([
  "SCHEDULED",
  "CANCELED",
  "INVALID_WAKE_TIME",
]);

/** Events that commit a world change and therefore bump state_version. */
const WORLD_EVENTS: ReadonlySet<string> = new Set<EventType>([
  "clock_advanced",
  "task_started",
  "task_completed",
  "order_arrived",
  "order_delivered",
  "wake_updated",
  "wake_fired",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function asStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

/** Narrow a union-typed record to one event type; the caller checked `ev.type`. */
function payloadOf<T extends EventType>(ev: EventRecord, _type: T): EventPayloads[T] {
  return ev.payload as EventPayloads[T];
}

function readItemQty(value: unknown): Map<Id, number> {
  const out = new Map<Id, number>();
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    const row = asObject(entry);
    const item_id = asStr(row["item_id"]);
    const quantity = asInt(row["quantity"]);
    if (item_id === "" || !Number.isFinite(quantity)) continue;
    out.set(item_id, (out.get(item_id) ?? 0) + quantity);
  }
  return out;
}

function readLots(value: unknown): Lot[] {
  if (!Array.isArray(value)) return [];
  const out: Lot[] = [];
  for (const entry of value) {
    const row = asObject(entry);
    out.push({
      id: asStr(row["id"]),
      item_id: asStr(row["item_id"]),
      quantity: asInt(row["quantity"]),
      produced_at_ms: asInt(row["produced_at_ms"]),
      task_id: asStr(row["task_id"]),
    });
  }
  return out;
}

function readTask(value: unknown): Task {
  const row = asObject(value);
  return {
    id: asStr(row["id"]),
    recipe_id: asStr(row["recipe_id"]),
    station_id: asStr(row["station_id"]),
    batches: asInt(row["batches"]),
    started_at_ms: asInt(row["started_at_ms"]),
    finish_at_ms: asInt(row["finish_at_ms"]),
  };
}

/**
 * Independent judge (doc 02 §11).
 *
 * Rebuilds the ledger from the frozen config, the order stream and the
 * candidate actions recorded in the event stream. It never reads the
 * simulator's revenue as truth: revenue is recomputed from the order values,
 * which are themselves recomputed from config prices. Recipe quantities,
 * station occupancy, timing and order uniqueness are all recomputed here.
 */
export function verifyRun(
  config: PublicConfig,
  orderStream: Order[],
  /** Read-only: the judge folds the stream, it never rewrites it. */
  events: readonly EventRecord[],
): VerifyResult {
  const mismatches: string[] = [];
  const add = (message: string): void => {
    if (mismatches.length < MAX_MISMATCHES) mismatches.push(message);
  };

  try {
    const ok = replay(config, orderStream, events, add);
    return { ok: ok && mismatches.length === 0, mismatches };
  } catch (error) {
    add(`judge aborted: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, mismatches };
  }
}

type Add = (message: string) => void;

function replay(
  config: PublicConfig,
  orderStream: Order[],
  events: readonly EventRecord[],
  add: Add,
): boolean {
  const items = new Map<Id, Item>();
  for (const item of config.items) {
    if (items.has(item.id)) add(`config: duplicate item id ${item.id}`);
    items.set(item.id, item);
  }
  const recipes = new Map<Id, Recipe>();
  for (const recipe of config.recipes) {
    if (recipes.has(recipe.id)) add(`config: duplicate recipe id ${recipe.id}`);
    recipes.set(recipe.id, recipe);
  }
  const stations = new Map<Id, true>();
  for (const station of config.stations) {
    if (stations.has(station.id)) add(`config: duplicate station id ${station.id}`);
    stations.set(station.id, true);
  }
  const end_at_ms = config.end_at_ms;
  const min_wake_delay_ms = config.limits.min_wake_delay_ms;

  // ---- frozen order stream (ground truth) ----
  const orders = new Map<Id, Order>();
  const arrivalOrder: Id[] = [];
  let last_arrival = -1;
  for (const [index, order] of orderStream.entries()) {
    if (orders.has(order.id)) add(`order stream: duplicate order id ${order.id}`);
    orders.set(order.id, order);
    let value = 0;
    let priced = true;
    for (const item of order.items) {
      const def = items.get(item.item_id);
      if (def === undefined) {
        add(`order ${order.id}: unknown item ${item.item_id}`);
        priced = false;
        continue;
      }
      if (!def.orderable) add(`order ${order.id}: item ${item.item_id} is not orderable`);
      value += def.price_minor * item.quantity;
    }
    if (priced && value !== order.value_minor) {
      add(`order ${order.id}: value_minor ${order.value_minor} != recomputed ${value}`);
    }
    if (order.arrived_at_ms >= end_at_ms) {
      add(`order ${order.id}: arrived_at_ms ${order.arrived_at_ms} is not before the deadline`);
    }
    if (order.arrived_at_ms < last_arrival) {
      add(`order stream: index ${index} breaks arrival order`);
    }
    last_arrival = order.arrived_at_ms;
    arrivalOrder.push(order.id);
  }

  // ---- judge-owned world ----
  let now = 0;
  let state_version = 0;
  let revenue = 0;
  const deliveredOrders = new Set<Id>();
  const arrivals = new Set<Id>();
  const arrivalsSeen: Id[] = [];
  /** station id -> sim time the station becomes free again. */
  const stationFreeAt = new Map<Id, number>();
  const openTasks = new Map<Id, Task>();
  const producedLots = new Map<Id, Lot>();
  const available = new Map<Id, number>();
  const producedTotal = new Map<Id, number>();
  const usedByProduction = new Map<Id, number>();
  const usedByDelivery = new Map<Id, number>();
  let pendingWake: number | null = null;
  let runFinished: EventPayloads["run_finished"] | null = null;
  let deliveryCount = 0;

  const bump = (ev: EventRecord): void => {
    if (WORLD_EVENTS.has(ev.type)) state_version += 1;
  };

  for (const [index, ev] of events.entries()) {
    if (ev.seq !== index + 1) add(`event #${index}: seq ${ev.seq} is not ${index + 1}`);
    if (runFinished !== null) add(`event #${index}: ${ev.type} after run_finished`);
    // clock_advanced is the one event stamped with the time it moves the clock to.
    const ceiling =
      ev.type === "clock_advanced"
        ? Math.max(now, asInt(payloadOf(ev, "clock_advanced").to_ms))
        : now;
    if (!Number.isFinite(asInt(ev.at_ms)) || asInt(ev.at_ms) > ceiling) {
      add(`event #${index} (${ev.type}): at_ms ${ev.at_ms} is ahead of clock ${ceiling}`);
    }

    switch (ev.type) {
      case "clock_advanced": {
        const p = payloadOf(ev, "clock_advanced");
        const from_ms = asInt(p.from_ms);
        const to_ms = asInt(p.to_ms);
        if (from_ms !== now) add(`clock_advanced: from_ms ${from_ms} != ${now}`);
        if (!Number.isFinite(to_ms) || to_ms < now) add(`clock_advanced: to_ms ${to_ms} < ${now}`);
        if (Number.isFinite(to_ms) && to_ms > end_at_ms) {
          add(`clock_advanced: to_ms ${to_ms} past the deadline ${end_at_ms}`);
        }
        if (Number.isFinite(to_ms)) now = to_ms;
        break;
      }
      case "order_arrived": {
        const p = payloadOf(ev, "order_arrived");
        const order = asObject(p.order);
        const id = asStr(order["id"]);
        const truth = orders.get(id);
        if (truth === undefined) {
          add(`order_arrived: ${id} is not in the order stream`);
        } else {
          if (arrivals.has(id)) add(`order_arrived: ${id} arrived twice`);
          if (asInt(order["arrived_at_ms"]) !== truth.arrived_at_ms) {
            add(`order_arrived: ${id} arrived_at_ms mismatch`);
          }
          if (asInt(order["arrived_at_ms"]) !== now) {
            add(`order_arrived: ${id} at ${order["arrived_at_ms"]} but clock is ${now}`);
          }
          if (asInt(order["arrived_at_ms"]) >= end_at_ms) {
            add(`order_arrived: ${id} arrived at/after the deadline`);
          }
          const want = readItemQty(truth.items);
          const got = readItemQty(order["items"]);
          if (!sameItemMap(want, got)) add(`order_arrived: ${id} items mismatch`);
          if (asInt(order["value_minor"]) !== truth.value_minor) {
            add(`order_arrived: ${id} value mismatch`);
          }
          if (arrivalsSeen.length > 0) {
            const prev = orders.get(arrivalsSeen[arrivalsSeen.length - 1] ?? "");
            if (prev !== undefined && truth.arrived_at_ms < prev.arrived_at_ms) {
              add(`order_arrived: ${id} breaks arrival ordering`);
            }
          }
        }
        arrivals.add(id);
        arrivalsSeen.push(id);
        break;
      }
      case "task_started": {
        const task = readTask(payloadOf(ev, "task_started").task);
        checkTaskStarted(task, now, add, {
          recipes,
          stations,
          stationFreeAt,
          items,
          available,
          usedByProduction,
        });
        if (openTasks.has(task.id)) add(`task_started: duplicate task id ${task.id}`);
        openTasks.set(task.id, task);
        if (stations.has(task.station_id) && Number.isFinite(task.finish_at_ms)) {
          stationFreeAt.set(task.station_id, task.finish_at_ms);
        }
        break;
      }
      case "task_completed": {
        const p = payloadOf(ev, "task_completed");
        const task = readTask(p.task);
        const open = openTasks.get(task.id);
        if (open === undefined) {
          add(`task_completed: task ${task.id} was never started or already completed`);
        } else if (
          open.recipe_id !== task.recipe_id ||
          open.station_id !== task.station_id ||
          open.batches !== task.batches ||
          open.started_at_ms !== task.started_at_ms ||
          open.finish_at_ms !== task.finish_at_ms
        ) {
          add(`task_completed: task ${task.id} payload differs from its task_started record`);
        }
        if (task.finish_at_ms !== now) {
          add(`task_completed: task ${task.id} finished at ${task.finish_at_ms} but clock is ${now}`);
        }
        const recipe = recipes.get(task.recipe_id);
        const lots = readLots(p.lots);
        if (recipe === undefined) {
          add(`task_completed: unknown recipe ${task.recipe_id}`);
        } else if (Number.isInteger(task.batches) && task.batches >= 1) {
          // Independent recipe quantity recomputation.
          const want = new Map<Id, number>();
          for (const out of recipe.outputs) {
            want.set(out.item_id, (want.get(out.item_id) ?? 0) + out.quantity * task.batches);
          }
          const got = new Map<Id, number>();
          for (const lot of lots) got.set(lot.item_id, (got.get(lot.item_id) ?? 0) + lot.quantity);
          if (!sameItemMap(want, got)) {
            add(
              `task_completed: task ${task.id} outputs ${describeMap(got)} != recipe ${describeMap(want)}`,
            );
          }
          for (const lot of lots) {
            if (lot.produced_at_ms !== task.finish_at_ms) {
              add(`task_completed: lot ${lot.id} produced_at_ms != task finish time`);
            }
            if (lot.task_id !== task.id) {
              add(`task_completed: lot ${lot.id} claims task ${lot.task_id}`);
            }
            if (producedLots.has(lot.id)) add(`task_completed: duplicate lot id ${lot.id}`);
            if (!Number.isInteger(lot.quantity) || lot.quantity <= 0) {
              add(`task_completed: lot ${lot.id} has non-positive quantity ${lot.quantity}`);
            }
            producedLots.set(lot.id, lot);
            const item = items.get(lot.item_id);
            if (item !== undefined && item.supply !== "produced") {
              add(`task_completed: lot ${lot.id} produces a non-produced item ${lot.item_id}`);
            }
            producedTotal.set(lot.item_id, (producedTotal.get(lot.item_id) ?? 0) + lot.quantity);
            available.set(lot.item_id, (available.get(lot.item_id) ?? 0) + lot.quantity);
          }
        }
        if (stations.has(task.station_id)) stationFreeAt.set(task.station_id, now);
        openTasks.delete(task.id);
        break;
      }
      case "order_delivered": {
        const p = payloadOf(ev, "order_delivered");
        const order_id = asStr(p.order_id);
        const truth = orders.get(order_id);
        if (truth === undefined) {
          add(`order_delivered: ${order_id} is not in the order stream`);
        } else {
          if (!arrivals.has(order_id)) {
            add(`order_delivered: ${order_id} was never arrived`);
          }
          if (deliveredOrders.has(order_id)) {
            add(`order_delivered: ${order_id} delivered more than once`);
          }
          if (asInt(p.at_ms) !== now) {
            add(`order_delivered: ${order_id} at_ms ${p.at_ms} != clock ${now}`);
          }
          const consumed = readItemQty(p.consumed);
          const want = readItemQty(truth.items);
          if (!sameItemMap(want, consumed)) {
            add(
              `order_delivered: ${order_id} consumed ${describeMap(consumed)} != order ${describeMap(want)}`,
            );
          }
          if (Array.isArray(p.consumed)) {
            const seen = new Set<Id>();
            for (const entry of p.consumed) {
              const row = asObject(entry);
              const lot_id = asStr(row["lot_id"]);
              const item_id = asStr(row["item_id"]);
              if (seen.has(lot_id)) {
                add(`order_delivered: ${order_id} references lot ${lot_id} twice`);
              }
              seen.add(lot_id);
              const lot = producedLots.get(lot_id);
              if (lot === undefined) {
                add(`order_delivered: ${order_id} consumes unknown lot ${lot_id}`);
              } else if (lot.item_id !== item_id) {
                add(`order_delivered: lot ${lot_id} holds ${lot.item_id}, not ${item_id}`);
              }
            }
          }
          for (const [item_id, quantity] of consumed) {
            const have = available.get(item_id) ?? 0;
            if (quantity > have) {
              add(`order_delivered: ${order_id} needs ${quantity} of ${item_id}, only ${have} produced`);
            }
            available.set(item_id, have - quantity);
            usedByDelivery.set(item_id, (usedByDelivery.get(item_id) ?? 0) + quantity);
          }
          // Revenue recomputed from config prices, not from the event payload.
          let value = 0;
          let priced = true;
          for (const item of truth.items) {
            const def = items.get(item.item_id);
            if (def === undefined) {
              priced = false;
              continue;
            }
            value += def.price_minor * item.quantity;
          }
          const claimed = asInt(p.value_minor);
          if (priced && claimed !== value) {
            add(`order_delivered: ${order_id} books ${claimed}, recomputed ${value}`);
          }
          revenue += value;
          if (asInt(p.revenue_minor) !== revenue) {
            add(`order_delivered: running revenue ${p.revenue_minor} != recomputed ${revenue}`);
          }
          deliveredOrders.add(order_id);
          deliveryCount += 1;
        }
        break;
      }
      case "action_rejected": {
        const p = payloadOf(ev, "action_rejected");
        const result = asObject(p.result);
        if (result["ok"] === true) add(`action_rejected: result claims success`);
        const code = asStr(result["code"]);
        if (!BUSINESS_CODES.has(code)) add(`action_rejected: unknown code ${code}`);
        if (asStr(result["action_id"]) === "") add(`action_rejected: missing action_id`);
        if (result["replayed"] === true) add(`action_rejected: replayed results create no event`);
        break;
      }
      case "wake_updated": {
        const p = payloadOf(ev, "wake_updated");
        const result = asObject(p.result);
        const code = asStr(result["code"]);
        if (!WAKE_CODES.has(code)) add(`wake_updated: unknown code ${code}`);
        if (code === "SCHEDULED") {
          const at = asInt(result["pending_wake_at_ms"]);
          if (!Number.isInteger(at) || at < now + min_wake_delay_ms || at > end_at_ms) {
            add(`wake_updated: ${at} outside [${now + min_wake_delay_ms}, ${end_at_ms}]`);
          }
          if (at <= now) add(`wake_updated: ${at} would loop in zero sim time`);
          pendingWake = at;
        } else if (code === "CANCELED") {
          // Doc 02 §7: null clears the pending wake, which may well be armed.
          pendingWake = null;
        }
        break;
      }
      case "wake_fired": {
        const p = payloadOf(ev, "wake_fired");
        if (pendingWake === null) add(`wake_fired: no wake was pending`);
        else if (pendingWake !== asInt(p.at_ms)) {
          add(`wake_fired: at_ms ${p.at_ms} != pending ${pendingWake}`);
        }
        pendingWake = null;
        break;
      }
      case "run_finished": {
        const p = payloadOf(ev, "run_finished");
        runFinished = p;
        break;
      }
      default:
        add(`unknown event type ${String(ev.type)}`);
        break;
    }

    bump(ev);
    if (asInt(ev.state_version) !== state_version) {
      add(
        `event #${index} (${ev.type}): state_version ${ev.state_version} != recomputed ${state_version}`,
      );
    }
  }

  // ---- terminal checks ----
  if (runFinished === null) {
    add("stream ends without run_finished");
  } else {
    const status = asStr(runFinished.status);
    if (status !== "completed" && status !== "candidate_failed" && status !== "infra_failed") {
      add(`run_finished: unexpected status ${status}`);
    }
    const claimed_revenue = asInt(runFinished.revenue_minor);
    if (claimed_revenue !== revenue) {
      add(`run_finished: revenue ${claimed_revenue} != independently recomputed ${revenue}`);
    }
    if (asInt(runFinished.delivered_orders) !== deliveryCount) {
      add(`run_finished: delivered_orders ${runFinished.delivered_orders} != ${deliveryCount}`);
    }
    const score = runFinished.score_minor;
    if (status === "completed") {
      if (now !== end_at_ms) add(`completed run settled at ${now}, not at the deadline ${end_at_ms}`);
      if (score !== null && score !== revenue) {
        add(`run_finished: score ${score} != recomputed ${revenue}`);
      }
    } else if (status === "candidate_failed") {
      if (score !== 0) add(`candidate_failed run must score 0, got ${String(score)}`);
    }
    if (!isHash(runFinished.state_hash)) add("run_finished: state_hash is not sha256 hex");
  }

  if (status_completed(runFinished) && arrivalsSeen.length !== arrivalOrder.length) {
    add(`completed run announced ${arrivalsSeen.length} arrivals, stream has ${arrivalOrder.length}`);
  }

  // ---- conservation (doc 02 §11) ----
  for (const [item_id, produced] of producedTotal) {
    const used = (usedByProduction.get(item_id) ?? 0) + (usedByDelivery.get(item_id) ?? 0);
    const onHand = available.get(item_id) ?? 0;
    if (onHand < 0) add(`negative inventory for ${item_id}: ${onHand}`);
    if (produced < used + onHand) {
      add(`conservation violated for ${item_id}: produced ${produced} < used ${used} + on hand ${onHand}`);
    }
  }

  return true;
}

function status_completed(runFinished: EventPayloads["run_finished"] | null): boolean {
  return runFinished !== null && asStr(runFinished.status) === "completed";
}

interface StartContext {
  recipes: Map<Id, Recipe>;
  stations: Map<Id, true>;
  stationFreeAt: Map<Id, number>;
  items: Map<Id, Item>;
  available: Map<Id, number>;
  usedByProduction: Map<Id, number>;
}

/** Independent recipe / occupancy / timing recomputation for `task_started`. */
function checkTaskStarted(
  task: Task,
  now: number,
  add: Add,
  ctx: StartContext,
): void {
  if (task.id === "") add("task_started: missing task id");
  if (task.started_at_ms !== now) {
    add(`task_started: ${task.id} started_at_ms ${task.started_at_ms} != clock ${now}`);
  }
  const recipe = ctx.recipes.get(task.recipe_id);
  if (recipe === undefined) {
    add(`task_started: unknown recipe ${task.recipe_id}`);
    return;
  }
  if (!ctx.stations.has(task.station_id)) {
    add(`task_started: unknown station ${task.station_id}`);
    return;
  }
  const option = recipe.station_options.find((o) => o.station_id === task.station_id);
  if (option === undefined) {
    add(`task_started: station ${task.station_id} cannot run recipe ${task.recipe_id}`);
    return;
  }
  const freeAt = ctx.stationFreeAt.get(task.station_id) ?? 0;
  if (task.started_at_ms < freeAt) {
    add(
      `task_started: station ${task.station_id} is busy until ${freeAt}, task ${task.id} starts at ${task.started_at_ms}`,
    );
  }
  if (!Number.isInteger(task.batches) || task.batches < 1 || task.batches > option.max_batches) {
    add(`task_started: batches ${task.batches} outside 1..${option.max_batches} for ${task.station_id}`);
    return;
  }
  // Doc 02 §4: duration is the fixed station entry value, batch independent.
  if (task.finish_at_ms !== task.started_at_ms + option.duration_ms) {
    add(
      `task_started: task ${task.id} finish_at_ms ${task.finish_at_ms} != ${task.started_at_ms} + ${option.duration_ms}`,
    );
  }
  for (const input of recipe.inputs) {
    // Doc 02 §11: virtual raw material is not part of the finite-stock ledger.
    const def = ctx.items.get(input.item_id);
    if (def !== undefined && def.supply !== "produced") continue;
    const need = input.quantity * task.batches;
    const have = ctx.available.get(input.item_id) ?? 0;
    if (have < need) {
      add(
        `task_started: task ${task.id} needs ${need} of ${input.item_id}, only ${have} produced`,
      );
      continue;
    }
    ctx.available.set(input.item_id, have - need);
    ctx.usedByProduction.set(input.item_id, (ctx.usedByProduction.get(input.item_id) ?? 0) + need);
  }
}

function sameItemMap(a: ReadonlyMap<Id, number>, b: ReadonlyMap<Id, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

function describeMap(map: ReadonlyMap<Id, number>): string {
  return `{${[...map.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([k, v]) => `${k}:${v}`)
    .join(",")}}`;
}
