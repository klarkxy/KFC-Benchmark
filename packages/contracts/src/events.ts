import type {
  ActionResult,
  Hash,
  Id,
  Lot,
  Order,
  Task,
  UInt,
  WakeResult,
} from "./types.js";

/**
 * Replay / audit event stream. The renderer consumes these records and
 * checkpoints only; it never re-executes candidate code.
 * `state_version` increments after each committed world-change event.
 */
export type EventType =
  | "clock_advanced"
  | "task_started"
  | "task_completed"
  | "order_arrived"
  | "order_delivered"
  | "action_rejected"
  | "wake_updated"
  | "wake_fired"
  | "run_finished";

export interface EventPayloads {
  clock_advanced: { from_ms: UInt; to_ms: UInt };
  task_started: { task: Task };
  task_completed: { task: Task; lots: Lot[] };
  order_arrived: { order: Order };
  order_delivered: {
    order_id: Id;
    delivery_id: Id;
    at_ms: UInt;
    consumed: { lot_id: Id; item_id: Id; quantity: number }[];
    value_minor: UInt;
    revenue_minor: UInt;
  };
  action_rejected: { result: ActionResult };
  wake_updated: { result: WakeResult };
  wake_fired: { at_ms: UInt };
  run_finished: {
    status: string;
    score_minor: UInt | null;
    revenue_minor: UInt;
    delivered_orders: UInt;
    state_hash: Hash;
  };
}

export interface EventRecord<T extends EventType = EventType> {
  /** Monotonic per run; pagination cursor in the platform API. */
  seq: UInt;
  at_ms: UInt;
  type: T;
  payload: EventPayloads[T];
  state_version: UInt;
}

export type ReplayKind = "practice" | "demo" | "scoring" | "human";

/** Binds a replay to its exact engine/scenario/method context. */
export interface ReplayHeader {
  replay_schema_version: "1";
  engine_version: string;
  protocol_version: string;
  benchmark_version: string;
  scenario_id: Id;
  scenario_hash: Hash;
  clock_mode: "paused_code" | "realtime";
  replay_kind: ReplayKind;
  order_stream: OrderStreamMeta;
}

export interface OrderStreamMeta {
  /** "public" streams ship with the repo; "sealed" ones were CI-secret generated. */
  visibility: "public" | "sealed";
  /** Present only for public streams. */
  seed?: number;
  generator_version: string;
}

/** Full replay file: header + events (checkpoints optional in phase 1). */
export interface ReplayFile {
  header: ReplayHeader;
  events: EventRecord[];
}
