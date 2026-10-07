import { canonicalSerialize } from "@kitchensched/contracts";
import type { Id, ItemQty, UInt } from "@kitchensched/contracts";

import { sha256Hex } from "./sha256.js";

/**
 * The digest is vendored (see ./sha256.ts) instead of taken from Node's crypto
 * module so the identical hash is produced by the Node host and by the browser
 * game.
 */
export { sha256Hex };

/**
 * The exact projection of the world that participates in the state hash
 * (doc 02 §11). Only integers, booleans, null, ASCII ids and structural
 * fields may appear here — display names and wall-clock metrics are
 * deliberately absent so the digest is stable across hosts and languages.
 *
 * Field list (frozen, protocol 0.3.0-web):
 *   now_ms, state_version, orders, lots, tasks, stations, revenue_minor,
 *   pending_wake_at_ms, deliveries
 */
export interface HashOrder {
  id: Id;
  arrived_at_ms: UInt;
  items: ItemQty[];
  value_minor: UInt;
  status: "pending" | "delivered";
}

export interface HashLot {
  id: Id;
  item_id: Id;
  quantity: number;
  produced_at_ms: UInt;
  task_id: Id;
}

export interface HashTask {
  id: Id;
  recipe_id: Id;
  station_id: Id;
  batches: number;
  started_at_ms: UInt;
  finish_at_ms: UInt;
}

export interface HashStation {
  id: Id;
  task_id: Id | null;
}

export interface HashDelivery {
  delivery_id: Id;
  order_id: Id;
  at_ms: UInt;
  value_minor: UInt;
}

export interface HashState {
  now_ms: UInt;
  state_version: UInt;
  /** Every arrived order, delivered ones included, sorted by id. */
  orders: HashOrder[];
  /** Whole lot ledger including exhausted (quantity 0) lots, sorted by id. */
  lots: HashLot[];
  /** Still-running tasks at the moment of hashing, sorted by id. */
  tasks: HashTask[];
  /** Every station of the config, sorted by id. */
  stations: HashStation[];
  revenue_minor: UInt;
  pending_wake_at_ms: UInt | null;
  /** Delivery ledger, sorted by delivery_id. */
  deliveries: HashDelivery[];
}

/** sha256 hex of the canonical serialization of the given hash state. */
export function computeStateHash(state: HashState): string {
  return sha256Hex(canonicalSerialize(state));
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}
