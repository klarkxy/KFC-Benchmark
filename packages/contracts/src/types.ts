/**
 * KitchenSched domain types — protocol 0.3.0-web.
 *
 * Field semantics mirror the frozen v0.2.0 JSON Schemas
 * (doc/08 开发规格与示例/*.schema.json). The only deliberate change is
 * protocol_version and the transport: candidates are TypeScript modules
 * instead of stdin/stdout JSONL processes.
 */

export const PROTOCOL_VERSION = "0.3.0-web" as const;

/** Opaque ASCII identifier. Candidates must not infer meaning from it. */
export type Id = string;

/** Non-negative integer, <= Number.MAX_SAFE_INTEGER. */
export type UInt = number;
/** Positive integer, <= Number.MAX_SAFE_INTEGER. */
export type PositiveInt = number;
/** SHA-256 hex digest, lowercase. */
export type Hash = string;

export interface ItemQty {
  item_id: Id;
  quantity: PositiveInt;
}

export interface LotQty {
  lot_id: Id;
  quantity: PositiveInt;
}

export type Supply = "unlimited_raw" | "produced";

export interface Item {
  id: Id;
  name: string;
  supply: Supply;
  orderable: boolean;
  /** 0 for non-orderable items; positive for sellable ones. */
  price_minor: UInt;
}

export interface StationDef {
  id: Id;
  kind: string;
  name: string;
}

export interface StationOption {
  station_id: Id;
  duration_ms: PositiveInt;
  max_batches: PositiveInt;
}

export interface Recipe {
  id: Id;
  name: string;
  /** Per-batch quantities; unlimited_raw inputs need no lot references. */
  inputs: ItemQty[];
  /** Per-batch quantities; outputs must be `produced` items only. */
  outputs: ItemQty[];
  station_options: StationOption[];
}

export interface Limits {
  init_wall_ms: PositiveInt;
  decision_wall_ms: PositiveInt;
  total_cpu_ms: PositiveInt;
  memory_mib: PositiveInt;
  max_decisions: PositiveInt;
  max_actions_per_decision: PositiveInt;
  max_total_actions: PositiveInt;
  min_wake_delay_ms: PositiveInt;
  max_message_bytes: PositiveInt;
  max_stderr_bytes: PositiveInt;
  max_pids: PositiveInt;
  max_writable_mib: PositiveInt;
  max_orders_per_run: PositiveInt;
}

/** Mechanical rule constants; identical for every scenario of this protocol. */
export interface Rules {
  clock: "paused_code";
  settlement: "whole_order";
  batch_timing: "fixed_within_capacity";
  finish_at_deadline_counts: true;
  delivery_duration_ms: 0;
  cancellation: "unsupported";
}

export type Difficulty = "easy" | "medium" | "complex";

/**
 * Static public configuration handed to the candidate at init.
 * Never contains seeds, future orders, or demand distributions.
 */
export interface PublicConfig {
  protocol_version: typeof PROTOCOL_VERSION;
  scenario_id: Id;
  scenario_version: string;
  difficulty: Difficulty;
  /** Global deadline; prep + business are one continuous simulation. */
  end_at_ms: PositiveInt;
  currency_unit: "credit_minor";
  currency_scale: 100;
  items: Item[];
  recipes: Recipe[];
  stations: StationDef[];
  rules: Rules;
  limits: Limits;
}

export interface Order {
  id: Id;
  arrived_at_ms: UInt;
  items: ItemQty[];
  /** Deterministic: sum of price_minor * quantity over items. */
  value_minor: PositiveInt;
}

export interface Lot {
  id: Id;
  item_id: Id;
  quantity: PositiveInt;
  produced_at_ms: UInt;
  task_id: Id;
}

export interface Task {
  id: Id;
  recipe_id: Id;
  station_id: Id;
  batches: PositiveInt;
  started_at_ms: UInt;
  finish_at_ms: UInt;
}

export interface StationState {
  id: Id;
  task_id: Id | null;
}

export type ActionCode =
  | "OK"
  | "UNKNOWN_RECIPE"
  | "UNKNOWN_STATION"
  | "INCOMPATIBLE_STATION"
  | "STATION_BUSY"
  | "INVALID_BATCH"
  | "UNKNOWN_LOT"
  | "DUPLICATE_LOT"
  | "INVALID_INPUT"
  | "INSUFFICIENT_INPUT"
  | "UNKNOWN_ORDER"
  | "INCOMPLETE_ORDER"
  | "ALREADY_DELIVERED"
  | "ACTION_ID_CONFLICT"
  | "DEADLINE_REACHED";

export interface ActionResult {
  action_id: Id;
  ok: boolean;
  code: ActionCode;
  /** Task id on successful start; Delivery id on successful deliver; else null. */
  entity_id: Id | null;
  /** True when the result came from the idempotency cache. */
  replayed: boolean;
}

export type WakeCode = "SCHEDULED" | "CANCELED" | "INVALID_WAKE_TIME";

export interface WakeResult {
  ok: boolean;
  code: WakeCode;
  pending_wake_at_ms: UInt | null;
}

/**
 * Full dynamic snapshot. Arrays are sorted by stable id;
 * previous_results preserves the action order of the previous decision.
 * Hosts must not sort by value, priority, or "recommended" order.
 */
export interface Observation {
  now_ms: UInt;
  state_version: UInt;
  /** True only for the endgame deliver-only callback. */
  final: boolean;
  orders: Order[];
  inventory: Lot[];
  running_tasks: Task[];
  stations: StationState[];
  revenue_minor: UInt;
  previous_results: ActionResult[];
  previous_wake_result: WakeResult | null;
  pending_wake_at_ms: UInt | null;
}

export interface StartAction {
  type: "start";
  /** Unique within the whole run. */
  action_id: Id;
  recipe_id: Id;
  station_id: Id;
  batches: PositiveInt;
  /** produced inputs only, aggregated per item; unlimited_raw omitted. */
  input_lots: LotQty[];
}

export interface DeliverAction {
  type: "deliver";
  action_id: Id;
  order_id: Id;
  /** Must exactly satisfy the whole order; no partial delivery. */
  output_lots: LotQty[];
}

export type Action = StartAction | DeliverAction;

/** Candidate reply to one observation. wake_at_ms is mandatory. */
export interface Decision {
  actions: Action[];
  /** null clears the pending wake; an integer replaces it. */
  wake_at_ms: UInt | null;
}

export type RunStatus =
  | "completed"
  | "candidate_failed"
  | "infra_failed"
  | "canceled"
  | "disqualified";

export interface EndResult {
  status: RunStatus;
  /** Official score: verified revenue on completed, 0 on candidate_failed, null on infra_failed. */
  score_minor: UInt | null;
  revenue_minor: UInt;
  delivered_orders: UInt;
  failure_code: string | null;
  final_action_results: ActionResult[];
  final_wake_result: WakeResult | null;
}
