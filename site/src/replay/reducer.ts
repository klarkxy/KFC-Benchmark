import type {
  EventPayloads,
  EventRecord,
  EventType,
  Lot,
  Order,
  Task,
} from "@kitchensched/contracts";

/**
 * `EventRecord<T>` is a single correlated record, so `EventRecord` alone
 * widens `payload` to a union that `switch (event.type)` cannot narrow.
 * This distributive form is the real shape the wire format has.
 */
export type ReplayEvent = { [K in EventType]: EventRecord<K> }[EventType];

/**
 * Replay reconstruction.
 *
 * The stream is the only source of truth: this module never re-executes
 * candidate code, it only folds `EventRecord`s into a display state. Both
 * `applyEvent` and `withCursor` are pure, so a future checkpointed stream can
 * seed `ReplayState` at event k and keep folding forward.
 */

export interface StationSnapshot {
  id: string;
  task: Task | null;
}

export interface DeliveredOrder {
  order_id: string;
  delivery_id: string;
  at_ms: number;
  value_minor: number;
}

export interface ReplayState {
  /** Virtual clock of the display cursor (not of the last applied event). */
  nowMs: number;
  stateVersion: number;
  eventsApplied: number;
  revenueMinor: number;
  deliveredOrders: number;
  rejectedActions: number;
  /** Arrived but not yet delivered, in arrival order. */
  queue: Order[];
  /** Most recent delivery, for the side panel ticker. */
  lastDelivered: DeliveredOrder | null;
  /** Outstanding produced lots, keyed by lot_id. */
  lots: Map<string, Lot>;
  /** Started but not yet completed, ordered by finish time. */
  activeTasks: Task[];
  /** Station ids in first-seen order, with their current task. */
  stations: StationSnapshot[];
  finished: EventPayloads["run_finished"] | null;
}

export function createInitialState(): ReplayState {
  return {
    nowMs: 0,
    stateVersion: 0,
    eventsApplied: 0,
    revenueMinor: 0,
    deliveredOrders: 0,
    rejectedActions: 0,
    queue: [],
    lastDelivered: null,
    lots: new Map(),
    activeTasks: [],
    stations: [],
    finished: null,
  };
}

function withStation(
  stations: readonly StationSnapshot[],
  stationId: string,
  task: Task | null,
): StationSnapshot[] {
  const index = stations.findIndex((station) => station.id === stationId);
  if (index < 0) return [...stations, { id: stationId, task }];
  const next = stations.slice();
  next[index] = { id: stationId, task };
  return next;
}

/** Folds one event. Returns a new state; the input is never mutated. */
export function applyEvent(state: ReplayState, event: ReplayEvent): ReplayState {
  const base: ReplayState = {
    ...state,
    nowMs: event.at_ms,
    stateVersion: event.state_version,
    eventsApplied: state.eventsApplied + 1,
  };

  switch (event.type) {
    case "clock_advanced":
      return base;

    case "task_started": {
      const task = event.payload.task;
      return {
        ...base,
        activeTasks: [...state.activeTasks, task].sort(
          (a, b) => a.finish_at_ms - b.finish_at_ms || a.id.localeCompare(b.id),
        ),
        stations: withStation(state.stations, task.station_id, task),
      };
    }

    case "task_completed": {
      const { task, lots } = event.payload;
      const nextLots = new Map(state.lots);
      for (const lot of lots) nextLots.set(lot.id, lot);
      return {
        ...base,
        lots: nextLots,
        activeTasks: state.activeTasks.filter((entry) => entry.id !== task.id),
        stations: state.stations.map((station) =>
          station.id === task.station_id && station.task?.id === task.id
            ? { id: station.id, task: null }
            : station,
        ),
      };
    }

    case "order_arrived":
      return { ...base, queue: [...state.queue, event.payload.order] };

    case "order_delivered": {
      const payload = event.payload;
      const nextLots = new Map(state.lots);
      const consumed = new Map<string, number>();
      for (const entry of payload.consumed) {
        consumed.set(entry.lot_id, (consumed.get(entry.lot_id) ?? 0) + entry.quantity);
      }
      for (const [lotId, quantity] of consumed) {
        const lot = nextLots.get(lotId);
        if (!lot) continue;
        const remaining = lot.quantity - quantity;
        if (remaining <= 0) nextLots.delete(lotId);
        else nextLots.set(lotId, { ...lot, quantity: remaining });
      }
      const delivered: DeliveredOrder = {
        order_id: payload.order_id,
        delivery_id: payload.delivery_id,
        at_ms: payload.at_ms,
        value_minor: payload.value_minor,
      };
      return {
        ...base,
        lots: nextLots,
        revenueMinor: payload.revenue_minor,
        deliveredOrders: state.deliveredOrders + 1,
        queue: state.queue.filter((order) => order.id !== payload.order_id),
        lastDelivered: delivered,
      };
    }

    case "action_rejected":
      return { ...base, rejectedActions: state.rejectedActions + 1 };

    case "wake_updated":
    case "wake_fired":
      return base;

    case "run_finished":
      return { ...base, finished: event.payload };

    default:
      return base;
  }
}

/** Moves the display cursor without touching the folded world state. */
export function withCursor(state: ReplayState, cursorMs: number): ReplayState {
  return state.nowMs === cursorMs ? state : { ...state, nowMs: cursorMs };
}

/** First index whose at_ms is strictly greater than cursorMs. */
export function upperBound(events: readonly ReplayEvent[], cursorMs: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const event = events[mid];
    if (event && event.at_ms <= cursorMs) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function totalDurationMs(events: readonly ReplayEvent[]): number {
  let last = 0;
  for (const event of events) if (event.at_ms > last) last = event.at_ms;
  return last;
}

/**
 * Stateful playback cursor over a replay.
 *
 * Forward seeks apply the missing events incrementally. A backward seek has no
 * inverse to replay, so it rebuilds from event 0 — phase 1 streams ship no
 * checkpoints; when they do, `resetTo` becomes "seek to the newest checkpoint".
 */
export class ReplayCursor {
  readonly durationMs: number;
  private readonly events: readonly ReplayEvent[];
  private state: ReplayState = createInitialState();
  private applied = 0;

  constructor(events: readonly ReplayEvent[]) {
    this.events = events;
    this.durationMs = totalDurationMs(events);
  }

  get appliedCount(): number {
    return this.applied;
  }

  get eventCount(): number {
    return this.events.length;
  }

  /** Rebuilds from event 0; the entry point for future checkpoint restores. */
  reset(): void {
    this.state = createInitialState();
    this.applied = 0;
  }

  seek(cursorMs: number): ReplayState {
    const target = upperBound(this.events, cursorMs);
    if (target < this.applied) this.reset();
    while (this.applied < target) {
      const event = this.events[this.applied];
      if (!event) break;
      this.state = applyEvent(this.state, event);
      this.applied += 1;
    }
    this.state = withCursor(this.state, cursorMs);
    return this.state;
  }
}

/** Outstanding stock per item, sorted by item_id. */
export interface InventoryEntry {
  item_id: string;
  quantity: number;
}

export function inventoryOf(state: ReplayState): InventoryEntry[] {
  const totals = new Map<string, number>();
  for (const lot of state.lots.values()) {
    if (lot.quantity <= 0) continue;
    totals.set(lot.item_id, (totals.get(lot.item_id) ?? 0) + lot.quantity);
  }
  return [...totals.entries()]
    .map(([item_id, quantity]) => ({ item_id, quantity }))
    .sort((a, b) => a.item_id.localeCompare(b.item_id));
}

/** 0..1 progress of a running task at the display cursor. */
export function taskProgress(task: Task, cursorMs: number): number {
  const span = task.finish_at_ms - task.started_at_ms;
  if (span <= 0) return 1;
  const ratio = (cursorMs - task.started_at_ms) / span;
  return Math.max(0, Math.min(1, ratio));
}
