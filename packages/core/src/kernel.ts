import { canonicalSerialize, mulberry32 } from "@kitchensched/contracts";
import type {
  Action,
  ActionCode,
  ActionResult,
  ControllerModule,
  Decision,
  DeliverAction,
  EndResult,
  EventPayloads,
  EventRecord,
  EventType,
  Id,
  Item,
  Lot,
  LotQty,
  Observation,
  Order,
  PublicConfig,
  Recipe,
  RunStatus,
  StartAction,
  StationOption,
  Task,
  UInt,
  WakeResult,
} from "@kitchensched/contracts";
import { computeStateHash } from "./hash.js";
import type { HashState } from "./hash.js";

/* ------------------------------------------------------------------ *
 * Public options / outputs (protocol 0.3.0-web)
 * ------------------------------------------------------------------ */

export interface RunOptions {
  /** Static public config; already schema- and semantics-validated. */
  config: PublicConfig;
  /** Full pre-generated order trajectory, sorted by arrived_at_ms. */
  orderStream: Order[];
  /** The candidate module. `init` runs once, `decide` once per observe. */
  controller: ControllerModule;
  policy_seed: number;
  /**
   * Wall clock used to enforce `limits.init_wall_ms` /
   * `limits.decision_wall_ms`. Defaults to `performance.now`. It never
   * influences the world, only the candidate's real-time budget.
   */
  now?: () => number;
}

export interface RunStats {
  decisions: number;
  totalActions: number;
  decisionWallMs: number;
}

export interface RunOutput {
  result: EndResult;
  events: EventRecord[];
  stateHash: string;
  stats: RunStats;
}

export type FailureCode = "PROTOCOL_ERROR" | "TIMEOUT" | "BUDGET_EXCEEDED";

/**
 * One step of an interactive (human-played) run: `observation` while the game
 * still has a decision to make, `done` once the final decision has been
 * applied, `invalid` when the submission cannot be accepted. The `events` array
 * holds the records emitted since the previous step.
 */
export type InteractiveStep =
  | { kind: "observation"; observation: Observation; events: EventRecord[] }
  | { kind: "done"; output: RunOutput; events: EventRecord[] }
  | { kind: "invalid"; reason: string };

/* ------------------------------------------------------------------ *
 * Internal world model
 * ------------------------------------------------------------------ */

interface WorldOrder extends Order {
  status: "pending" | "delivered";
  arrived: boolean;
  /** Frozen queue sequence from the pre-sorted order stream. */
  arrival_seq: number;
}

interface WorldDelivery {
  delivery_id: Id;
  order_id: Id;
  at_ms: UInt;
  value_minor: UInt;
  consumed: { lot_id: Id; item_id: Id; quantity: number }[];
}

type PendingEvent =
  | { kind: "task_completion"; at_ms: number; seq: number; task_id: Id }
  | { kind: "order_arrival"; at_ms: number; seq: number; order_id: Id }
  | { kind: "wake"; at_ms: number; seq: number };

interface CachedAction {
  content: string;
  result: ActionResult;
}

const WAKE_CODE_INVALID = "INVALID_WAKE_TIME" as const;

/* ------------------------------------------------------------------ *
 * Untrusted-input normalization (doc 02 §9)
 * ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLotRefs(value: unknown): LotQty[] | null {
  if (!Array.isArray(value)) return null;
  const out: LotQty[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return null;
    const lot_id = entry["lot_id"];
    const quantity = entry["quantity"];
    if (typeof lot_id !== "string" || lot_id.length === 0) return null;
    if (typeof quantity !== "number" || !Number.isFinite(quantity)) return null;
    out.push({ lot_id, quantity });
  }
  return out;
}

/**
 * A malformed action is a protocol error (doc 02 §9: 动作结构错误), not a
 * business rejection. Only what cannot be read as the declared schema at
 * all is rejected here; semantic checks (batches range, quantity match,
 * ...) stay in the business layer and become ActionResult codes.
 */
function normalizeAction(value: unknown): Action | null {
  if (!isPlainObject(value)) return null;
  const action_id = value["action_id"];
  if (typeof action_id !== "string" || action_id.length === 0) return null;
  const type = value["type"];
  if (type === "start") {
    const recipe_id = value["recipe_id"];
    const station_id = value["station_id"];
    const batches = value["batches"];
    if (typeof recipe_id !== "string" || recipe_id.length === 0) return null;
    if (typeof station_id !== "string" || station_id.length === 0) return null;
    if (typeof batches !== "number" || !Number.isFinite(batches)) return null;
    const input_lots = normalizeLotRefs(value["input_lots"]);
    if (input_lots === null) return null;
    return { type: "start", action_id, recipe_id, station_id, batches, input_lots };
  }
  if (type === "deliver") {
    const order_id = value["order_id"];
    if (typeof order_id !== "string" || order_id.length === 0) return null;
    const output_lots = normalizeLotRefs(value["output_lots"]);
    if (output_lots === null) return null;
    return { type: "deliver", action_id, order_id, output_lots };
  }
  return null;
}

export function normalizeDecision(value: unknown): Decision | null {
  if (!isPlainObject(value)) return null;
  const actions = value["actions"];
  if (!Array.isArray(actions)) return null;
  if (!Object.prototype.hasOwnProperty.call(value, "wake_at_ms")) return null;
  const wake_at_ms = value["wake_at_ms"];
  if (wake_at_ms !== null && (typeof wake_at_ms !== "number" || !Number.isFinite(wake_at_ms))) {
    return null;
  }
  const out: Action[] = [];
  for (const raw of actions) {
    const action = normalizeAction(raw);
    if (action === null) return null;
    out.push(action);
  }
  return { actions: out, wake_at_ms };
}

/** Lot order is not semantic: two spellings of the same lot set are equal. */
function sortLotRefs(refs: readonly LotQty[]): LotQty[] {
  return [...refs]
    .sort((a, b) => (a.lot_id < b.lot_id ? -1 : a.lot_id > b.lot_id ? 1 : a.quantity - b.quantity))
    .map((r) => ({ lot_id: r.lot_id, quantity: r.quantity }));
}

function actionContent(action: Action): string {
  if (action.type === "start") {
    return canonicalSerialize({
      type: "start",
      action_id: action.action_id,
      recipe_id: action.recipe_id,
      station_id: action.station_id,
      batches: action.batches,
      input_lots: sortLotRefs(action.input_lots),
    });
  }
  return canonicalSerialize({
    type: "deliver",
    action_id: action.action_id,
    order_id: action.order_id,
    output_lots: sortLotRefs(action.output_lots),
  });
}

function sortById<T extends { id: Id }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Detach a JSON-shaped value from the kernel's own state. */
function deepCopyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneOrder(order: WorldOrder): Order {
  return {
    id: order.id,
    arrived_at_ms: order.arrived_at_ms,
    items: order.items.map((it) => ({ item_id: it.item_id, quantity: it.quantity })),
    value_minor: order.value_minor,
  };
}

/* ------------------------------------------------------------------ *
 * Kernel
 * ------------------------------------------------------------------ */

export class Kernel {
  readonly config: PublicConfig;
  readonly limits: PublicConfig["limits"];
  private readonly controller: ControllerModule;
  private readonly wallNow: () => number;
  private readonly items: Map<Id, Item>;
  private readonly recipes: Map<Id, Recipe>;
  private readonly stationIds: Id[];
  private readonly orders: Map<Id, WorldOrder>;
  private readonly arrivalQueue: Id[];

  private now_ms = 0;
  private state_version = 0;
  private readonly lots = new Map<Id, Lot>();
  private readonly tasks = new Map<Id, Task>();
  private readonly occupancy = new Map<Id, Id | null>();
  private readonly deliveries: WorldDelivery[] = [];
  private revenue_minor = 0;
  private pending_wake_at_ms: UInt | null = null;

  private queue: PendingEvent[] = [];
  private arrival_cursor = 0;
  private readonly events: EventRecord[] = [];
  private event_seq = 1;
  private internal_seq = 1;
  private task_counter = 0;
  private lot_counter = 0;
  private delivery_counter = 0;

  private readonly actionCache = new Map<Id, CachedAction>();
  private previous_results: ActionResult[] = [];
  private previous_wake_result: WakeResult | null = null;
  private final_action_results: ActionResult[] = [];
  private final_wake_result: WakeResult | null = null;

  /* Interactive session state (human play). The controller is never consulted
   * and no wall clock is read while it is active. */
  private interactive_mode = false;
  private interactive_observation: Observation | null = null;
  private interactive_final = false;
  private interactive_output: RunOutput | null = null;
  /** Events already handed to the caller; the rest come with the next step. */
  private interactive_cursor = 0;

  private decisions = 0;
  private total_actions = 0;
  private decision_wall_ms = 0;
  private failure: FailureCode | null = null;
  private readonly seed: number;

  /** Conservation ledger (doc 02 §11); never part of the state hash. */
  private readonly produced_total = new Map<Id, number>();
  private readonly consumed_by_production = new Map<Id, number>();
  private readonly consumed_by_delivery = new Map<Id, number>();
  private readonly raw_consumed = new Map<Id, number>();

  constructor(opts: RunOptions) {
    if (
      opts === null ||
      typeof opts !== "object" ||
      opts.controller === null ||
      typeof opts.controller !== "object" ||
      typeof opts.controller.init !== "function" ||
      typeof opts.controller.decide !== "function"
    ) {
      throw new TypeError("runScenario: opts.controller must satisfy ControllerModule");
    }
    this.config = opts.config;
    this.limits = opts.config.limits;
    this.controller = opts.controller;
    this.wallNow = opts.now ?? (() => performance.now());
    this.seed = opts.policy_seed;

    this.items = new Map(opts.config.items.map((item) => [item.id, item]));
    this.recipes = new Map(opts.config.recipes.map((recipe) => [recipe.id, recipe]));
    this.stationIds = opts.config.stations.map((s) => s.id);
    for (const id of this.stationIds) this.occupancy.set(id, null);

    this.orders = new Map();
    // Frozen queue order: arrival time first, stream position as tiebreak.
    const stream = opts.orderStream
      .map((order, index) => ({ order, index }))
      .sort((a, b) =>
        a.order.arrived_at_ms - b.order.arrived_at_ms || a.index - b.index,
      );
    this.arrivalQueue = stream.map(({ order }, seq) => {
      this.orders.set(order.id, { ...order, status: "pending", arrived: false, arrival_seq: seq });
      return order.id;
    });
  }

  /* ------------------------------ run ------------------------------ */

  run(): RunOutput {
    this.initController();
    if (this.failure === null) {
      // t=0: unconditional first observe with the pristine world.
      this.observe_and_decide(false);
    }
    while (this.failure === null) {
      const final = this.tick_once();
      this.observe_and_decide(final);
      if (final) break;
    }
    return this.finish();
  }

  private initController(): void {
    const t0 = this.wallNow();
    try {
      // The candidate is untrusted: hand it a private copy so a mutation
      // cannot reach the deadline or the limits this run is judged against.
      this.controller.init(deepCopyJson(this.config), {
        policy_seed: this.seed,
        random: mulberry32(this.seed),
      });
    } catch {
      this.failure = "PROTOCOL_ERROR";
      return;
    }
    if (this.wallNow() - t0 > this.limits.init_wall_ms) {
      this.failure = "TIMEOUT";
    }
  }

  /* --------------------------- event loop -------------------------- */

  /**
   * One iteration of the event loop, shared verbatim by `run()` and by
   * `advanceInteractive()`: move the clock to the next tick, then process it.
   * Returns whether the observe that follows is the final deliver-only one.
   *
   * Doc 02 §8: at the deadline, tasks finishing exactly then settle first and
   * the endgame registers no wake.
   */
  private tick_once(): boolean {
    const t = this.next_tick_time();
    if (t > this.now_ms) {
      const from_ms = this.now_ms;
      this.now_ms = t;
      this.emit("clock_advanced", { from_ms, to_ms: t });
    }
    if (t >= this.config.end_at_ms) {
      this.settle_tasks_at(this.now_ms);
      this.clear_pending_wake();
      return true;
    }
    this.process_tick(t);
    return false;
  }

  private next_tick_time(): number {
    let min: number | null = this.next_arrival_time();
    for (const ev of this.queue) {
      if (min === null || ev.at_ms < min) min = ev.at_ms;
    }
    if (min === null) return this.config.end_at_ms;
    return Math.min(min, this.config.end_at_ms);
  }

  /** Arrival time of the oldest order that has not been announced yet. */
  private next_arrival_time(): number | null {
    while (this.arrival_cursor < this.arrivalQueue.length) {
      const id = this.arrivalQueue[this.arrival_cursor];
      const order = id === undefined ? undefined : this.orders.get(id);
      if (order === undefined) {
        this.arrival_cursor += 1;
        continue;
      }
      if (order.arrived) {
        this.arrival_cursor += 1;
        continue;
      }
      return order.arrived_at_ms;
    }
    return null;
  }

  /**
   * Collect every event at the earliest time t and process it by category:
   * task completion -> order arrival -> wake consumption; within a category
   * by frozen event sequence. Exactly one merged observe follows.
   */
  private process_tick(t: number): void {
    this.settle_tasks_at(t);
    while (this.arrival_cursor < this.arrivalQueue.length) {
      const id = this.arrivalQueue[this.arrival_cursor];
      const order = id === undefined ? undefined : this.orders.get(id);
      if (order === undefined) {
        this.arrival_cursor += 1;
        continue;
      }
      if (order.arrived_at_ms > t) break;
      this.arrival_cursor += 1;
      if (order.arrived) continue;
      order.arrived = true;
      this.emit("order_arrived", { order: cloneOrder(order) });
    }
    if (this.pending_wake_at_ms !== null && this.pending_wake_at_ms === t) {
      this.pending_wake_at_ms = null;
      this.emit("wake_fired", { at_ms: t });
    }
    this.prune_queue();
  }

  private settle_tasks_at(t: number): void {
    const due = this.queue
      .filter((ev): ev is Extract<PendingEvent, { kind: "task_completion" }> =>
        ev.kind === "task_completion" && ev.at_ms === t,
      )
      .sort((a, b) => a.seq - b.seq);
    for (const ev of due) {
      const task = this.tasks.get(ev.task_id);
      if (task === undefined) continue;
      const recipe = this.recipes.get(task.recipe_id);
      this.tasks.delete(task.id);
      this.occupancy.set(task.station_id, null);
      const lots: Lot[] = [];
      if (recipe !== undefined) {
        for (const out of recipe.outputs) {
          const lot: Lot = {
            id: `lot-${++this.lot_counter}`,
            item_id: out.item_id,
            quantity: out.quantity * task.batches,
            produced_at_ms: task.finish_at_ms,
            task_id: task.id,
          };
          this.lots.set(lot.id, lot);
          this.produced_total.set(lot.item_id, (this.produced_total.get(lot.item_id) ?? 0) + lot.quantity);
          lots.push({ ...lot });
        }
      }
      this.emit("task_completed", { task: { ...task }, lots: lots.map((l) => ({ ...l })) });
    }
    this.prune_queue();
  }

  private prune_queue(): void {
    if (this.queue.length > 0) this.queue = this.queue.filter((ev) => ev.at_ms > this.now_ms);
  }

  /* --------------------------- observation -------------------------- */

  private observe_and_decide(final: boolean): void {
    if (this.failure !== null) return;
    if (this.decisions >= this.limits.max_decisions) {
      this.failure = "BUDGET_EXCEEDED";
      return;
    }
    const observation = this.build_observation(final);
    this.decisions += 1;

    let raw: unknown;
    const t0 = this.wallNow();
    try {
      raw = this.controller.decide(observation);
    } catch {
      this.failure = "PROTOCOL_ERROR";
      return;
    }
    const elapsed = this.wallNow() - t0;
    this.decision_wall_ms += elapsed;
    if (elapsed > this.limits.decision_wall_ms) {
      this.failure = "TIMEOUT";
      return;
    }

    const decision = normalizeDecision(raw);
    if (decision === null) {
      this.failure = "PROTOCOL_ERROR";
      return;
    }
    this.applyDecision(decision, final);
  }

  /**
   * The half of a decision that does not depend on who authored it, shared by
   * the controller callback and by an interactive submission. Keeping one
   * implementation is what makes an interactive event stream indistinguishable
   * from a `run()` event stream for the same decisions.
   */
  private applyDecision(decision: Decision, final: boolean): void {
    if (decision.actions.length > this.limits.max_actions_per_decision) {
      this.failure = "BUDGET_EXCEEDED";
      return;
    }
    if (this.total_actions + decision.actions.length > this.limits.max_total_actions) {
      this.failure = "BUDGET_EXCEEDED";
      return;
    }
    this.total_actions += decision.actions.length;

    const results: ActionResult[] = [];
    for (const action of decision.actions) {
      results.push(this.execute_action(action, final));
    }
    this.check_conservation();
    const wake_result = this.update_wake(decision.wake_at_ms, final);

    if (final) {
      this.final_action_results = results;
      this.final_wake_result = wake_result;
    } else {
      this.previous_results = results;
      this.previous_wake_result = wake_result;
    }
  }

  private build_observation(final: boolean): Observation {
    const orders: Order[] = [];
    for (const order of this.orders.values()) {
      if (order.arrived && order.status === "pending") orders.push(cloneOrder(order));
    }
    const inventory: Lot[] = [];
    for (const lot of this.lots.values()) {
      // Doc 02 §2: exhausted lots leave the observation but stay in the ledger.
      if (lot.quantity > 0) inventory.push({ ...lot });
    }
    const stations = this.stationIds
      .slice()
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((id) => ({ id, task_id: this.occupancy.get(id) ?? null }));
    return {
      now_ms: this.now_ms,
      state_version: this.state_version,
      final,
      orders: sortById(orders),
      inventory: sortById(inventory),
      running_tasks: sortById([...this.tasks.values()].map((t) => ({ ...t }))),
      stations,
      revenue_minor: this.revenue_minor,
      previous_results: this.previous_results.map((r) => ({ ...r })),
      previous_wake_result:
        this.previous_wake_result === null ? null : { ...this.previous_wake_result },
      pending_wake_at_ms: this.pending_wake_at_ms,
    };
  }

  /* ------------------------- interactive --------------------------- */

  /**
   * Starts an interactive run and pauses at the t=0 observation. The startup
   * events are exactly the ones `run()` emits before its first callback (none
   * today), the injected controller is never consulted, and no wall-clock
   * budget is measured: the human is the policy, so TIMEOUT/PROTOCOL_ERROR
   * cannot occur. Every later step reuses `tick_once`, `build_observation` and
   * `applyDecision`, which is what keeps the two event streams identical.
   */
  beginInteractive(): InteractiveStep {
    if (this.interactive_mode) {
      return { kind: "invalid", reason: "beginInteractive: this kernel is already interactive" };
    }
    if (this.now_ms !== 0 || this.events.length > 0 || this.decisions > 0) {
      return { kind: "invalid", reason: "beginInteractive: this kernel has already run" };
    }
    this.interactive_mode = true;
    if (this.decisions >= this.limits.max_decisions) {
      return this.finishInteractive();
    }
    return this.observeInteractive(false);
  }

  /**
   * Applies one human decision and advances to the next decision point (or to
   * the end). A decision that fails `normalizeDecision`, or a submission made
   * with no observation pending or after the run is over, is rejected with zero
   * state mutation: no event, no clock movement, session still usable.
   *
   * Semantically illegal actions are not rejected here — they become ordinary
   * ActionResult codes in the next observation, exactly as in `run()`.
   */
  advanceInteractive(decision: Decision): InteractiveStep {
    if (!this.interactive_mode) {
      return { kind: "invalid", reason: "advanceInteractive: beginInteractive has not been called" };
    }
    if (this.interactive_output !== null) {
      return { kind: "invalid", reason: "advanceInteractive: the run is already finished" };
    }
    if (this.interactive_observation === null) {
      return { kind: "invalid", reason: "advanceInteractive: no observation is pending" };
    }
    const normalized = normalizeDecision(decision);
    if (normalized === null) {
      return { kind: "invalid", reason: "advanceInteractive: decision is not a well-formed Decision" };
    }

    const final = this.interactive_final;
    this.interactive_observation = null;
    this.applyDecision(normalized, final);
    // A budget violation (the one failure code interactive mode can still
    // encode, because it is a scenario rule rather than a timing artifact)
    // ends the run exactly as it ends run().
    if (this.failure !== null) return this.finishInteractive();
    if (final) return this.finishInteractive();

    const next_final = this.tick_once();
    if (this.decisions >= this.limits.max_decisions) {
      this.failure = "BUDGET_EXCEEDED";
      return this.finishInteractive();
    }
    return this.observeInteractive(next_final);
  }

  /** Builds and parks the next observation, counting it like run() does. */
  private observeInteractive(final: boolean): InteractiveStep {
    const observation = this.build_observation(final);
    this.decisions += 1;
    this.interactive_observation = observation;
    this.interactive_final = final;
    return { kind: "observation", observation, events: this.takeInteractiveEvents() };
  }

  private finishInteractive(): InteractiveStep {
    const output = this.finish();
    this.interactive_output = output;
    return { kind: "done", output, events: this.takeInteractiveEvents() };
  }

  /** The records emitted since the previous step, in seq order. */
  private takeInteractiveEvents(): EventRecord[] {
    const slice = this.events.slice(this.interactive_cursor);
    this.interactive_cursor = this.events.length;
    return slice;
  }

  /* ----------------------------- actions --------------------------- */

  private execute_action(action: Action, final: boolean): ActionResult {
    const content = actionContent(action);
    const cached = this.actionCache.get(action.action_id);
    if (cached !== undefined) {
      if (cached.content === content) {
        // Idempotent replay: no re-execution, no events, no world version bump.
        return { ...cached.result, replayed: true };
      }
      const conflict: ActionResult = {
        action_id: action.action_id,
        ok: false,
        code: "ACTION_ID_CONFLICT",
        entity_id: null,
        replayed: false,
      };
      this.emit("action_rejected", { result: conflict }, false);
      return conflict;
    }
    const result =
      action.type === "start" ? this.do_start(action, final) : this.do_deliver(action);
    this.actionCache.set(action.action_id, { content, result });
    // A business rejection is a log append: no world change, no version bump.
    if (!result.ok) this.emit("action_rejected", { result: { ...result } }, false);
    return result;
  }

  private reject(action_id: Id, code: ActionCode): ActionResult {
    return { action_id, ok: false, code, entity_id: null, replayed: false };
  }

  private is_produced(item_id: Id): boolean {
    const item = this.items.get(item_id);
    // Unknown item ids are treated as produced: a lot reference is required.
    return item === undefined ? true : item.supply === "produced";
  }

  private do_start(action: StartAction, final: boolean): ActionResult {
    // Fixed validation order (doc 02 §4). Idempotency already ran upstream.
    if (final) return this.reject(action.action_id, "DEADLINE_REACHED");

    const recipe = this.recipes.get(action.recipe_id);
    if (recipe === undefined) return this.reject(action.action_id, "UNKNOWN_RECIPE");

    if (!this.occupancy.has(action.station_id)) {
      return this.reject(action.action_id, "UNKNOWN_STATION");
    }
    const option: StationOption | undefined = recipe.station_options.find(
      (o) => o.station_id === action.station_id,
    );
    if (option === undefined) return this.reject(action.action_id, "INCOMPATIBLE_STATION");

    if ((this.occupancy.get(action.station_id) ?? null) !== null) {
      return this.reject(action.action_id, "STATION_BUSY");
    }

    if (!Number.isInteger(action.batches) || action.batches < 1 || action.batches > option.max_batches) {
      return this.reject(action.action_id, "INVALID_BATCH");
    }

    // Lots exist and are unique. Duplicates are rejected before lookups.
    const seen = new Set<Id>();
    const refs: { lot: Lot; quantity: number }[] = [];
    for (const ref of action.input_lots) {
      if (seen.has(ref.lot_id)) return this.reject(action.action_id, "DUPLICATE_LOT");
      seen.add(ref.lot_id);
    }
    for (const ref of action.input_lots) {
      const lot = this.lots.get(ref.lot_id);
      if (lot === undefined || lot.quantity <= 0) {
        return this.reject(action.action_id, "UNKNOWN_LOT");
      }
      refs.push({ lot, quantity: ref.quantity });
    }

    // Item/qty aggregation must match recipe x batches exactly.
    const required = new Map<Id, number>();
    for (const input of recipe.inputs) {
      if (this.is_produced(input.item_id)) {
        required.set(input.item_id, (required.get(input.item_id) ?? 0) + input.quantity * action.batches);
      }
    }
    const provided = new Map<Id, number>();
    for (const { lot, quantity } of refs) {
      provided.set(lot.item_id, (provided.get(lot.item_id) ?? 0) + quantity);
    }
    if (!sameItemQty(required, provided)) return this.reject(action.action_id, "INVALID_INPUT");

    // Sufficient quantities in the world (defensive: aggregation already pins it).
    for (const [item_id, need] of required) {
      let have = 0;
      for (const { lot, quantity } of refs) {
        if (lot.item_id === item_id) have += Math.min(lot.quantity, quantity);
      }
      if (have < need) return this.reject(action.action_id, "INSUFFICIENT_INPUT");
    }

    // All-or-nothing commit.
    for (const { lot, quantity } of refs) {
      lot.quantity -= quantity;
      this.consumed_by_production.set(
        lot.item_id,
        (this.consumed_by_production.get(lot.item_id) ?? 0) + quantity,
      );
    }
    for (const input of recipe.inputs) {
      if (!this.is_produced(input.item_id)) {
        this.raw_consumed.set(
          input.item_id,
          (this.raw_consumed.get(input.item_id) ?? 0) + input.quantity * action.batches,
        );
      }
    }
    const task: Task = {
      id: `task-${++this.task_counter}`,
      recipe_id: recipe.id,
      station_id: action.station_id,
      batches: action.batches,
      started_at_ms: this.now_ms,
      finish_at_ms: this.now_ms + option.duration_ms,
    };
    this.tasks.set(task.id, task);
    this.occupancy.set(task.station_id, task.id);
    this.queue.push({
      kind: "task_completion",
      at_ms: task.finish_at_ms,
      seq: this.internal_seq++,
      task_id: task.id,
    });
    this.emit("task_started", { task: { ...task } });
    return { action_id: action.action_id, ok: true, code: "OK", entity_id: task.id, replayed: false };
  }

  private do_deliver(action: DeliverAction): ActionResult {
    const order = this.orders.get(action.order_id);
    if (order === undefined || !order.arrived) {
      return this.reject(action.action_id, "UNKNOWN_ORDER");
    }
    if (order.status === "delivered") {
      return this.reject(action.action_id, "ALREADY_DELIVERED");
    }

    const seen = new Set<Id>();
    const refs: { lot: Lot; quantity: number }[] = [];
    for (const ref of action.output_lots) {
      if (seen.has(ref.lot_id)) return this.reject(action.action_id, "DUPLICATE_LOT");
      seen.add(ref.lot_id);
    }
    for (const ref of action.output_lots) {
      const lot = this.lots.get(ref.lot_id);
      if (lot === undefined || lot.quantity <= 0) {
        return this.reject(action.action_id, "UNKNOWN_LOT");
      }
      refs.push({ lot, quantity: ref.quantity });
    }

    const required = new Map<Id, number>();
    for (const item of order.items) {
      required.set(item.item_id, (required.get(item.item_id) ?? 0) + item.quantity);
    }
    const provided = new Map<Id, number>();
    for (const { lot, quantity } of refs) {
      provided.set(lot.item_id, (provided.get(lot.item_id) ?? 0) + quantity);
    }
    if (!sameItemQty(required, provided)) return this.reject(action.action_id, "INCOMPLETE_ORDER");

    for (const [item_id, need] of required) {
      let have = 0;
      for (const { lot, quantity } of refs) {
        if (lot.item_id === item_id) have += Math.min(lot.quantity, quantity);
      }
      if (have < need) return this.reject(action.action_id, "INSUFFICIENT_INPUT");
    }

    // Commit: consume lots, flip the order, append the delivery, book revenue.
    for (const { lot, quantity } of refs) {
      lot.quantity -= quantity;
      this.consumed_by_delivery.set(
        lot.item_id,
        (this.consumed_by_delivery.get(lot.item_id) ?? 0) + quantity,
      );
    }
    order.status = "delivered";
    const delivery: WorldDelivery = {
      delivery_id: `dlv-${++this.delivery_counter}`,
      order_id: order.id,
      at_ms: this.now_ms,
      value_minor: order.value_minor,
      consumed: refs.map(({ lot, quantity }) => ({
        lot_id: lot.id,
        item_id: lot.item_id,
        quantity,
      })),
    };
    this.deliveries.push(delivery);
    this.revenue_minor += order.value_minor;
    this.emit("order_delivered", {
      order_id: delivery.order_id,
      delivery_id: delivery.delivery_id,
      at_ms: delivery.at_ms,
      consumed: delivery.consumed.map((c) => ({ ...c })),
      value_minor: delivery.value_minor,
      revenue_minor: this.revenue_minor,
    });
    return {
      action_id: action.action_id,
      ok: true,
      code: "OK",
      entity_id: delivery.delivery_id,
      replayed: false,
    };
  }

  /* ------------------------------ wake ----------------------------- */

  private clear_pending_wake(): void {
    if (this.pending_wake_at_ms === null) return;
    this.pending_wake_at_ms = null;
    this.queue = this.queue.filter((ev) => ev.kind !== "wake");
  }

  private update_wake(wake_at_ms: number | null, final: boolean): WakeResult {
    if (final && wake_at_ms !== null) {
      return {
        ok: false,
        code: WAKE_CODE_INVALID,
        pending_wake_at_ms: this.pending_wake_at_ms,
      };
    }
    if (wake_at_ms === null) {
      const had = this.pending_wake_at_ms !== null;
      this.clear_pending_wake();
      const result: WakeResult = { ok: true, code: "CANCELED", pending_wake_at_ms: null };
      if (had) this.emit("wake_updated", { result: { ...result } });
      return result;
    }
    const earliest = this.now_ms + this.limits.min_wake_delay_ms;
    if (
      !Number.isInteger(wake_at_ms) ||
      wake_at_ms < earliest ||
      wake_at_ms > this.config.end_at_ms
    ) {
      return {
        ok: false,
        code: WAKE_CODE_INVALID,
        pending_wake_at_ms: this.pending_wake_at_ms,
      };
    }
    if (this.pending_wake_at_ms === wake_at_ms) {
      return { ok: true, code: "SCHEDULED", pending_wake_at_ms: wake_at_ms };
    }
    this.clear_pending_wake();
    this.pending_wake_at_ms = wake_at_ms;
    this.queue.push({ kind: "wake", at_ms: wake_at_ms, seq: this.internal_seq++ });
    const result: WakeResult = { ok: true, code: "SCHEDULED", pending_wake_at_ms: wake_at_ms };
    this.emit("wake_updated", { result: { ...result } });
    return result;
  }

  /* ----------------------------- events ---------------------------- */

  private emit<T extends EventType>(type: T, payload: EventPayloads[T], worldChange = true): void {
    if (worldChange) this.state_version += 1;
    this.events.push({
      seq: this.event_seq++,
      at_ms: this.now_ms,
      type,
      payload,
      state_version: this.state_version,
    });
  }

  /* -------------------------- finalization -------------------------- */

  /** The exact projection hashed at the end of the run (doc 02 §11). */
  hashState(): HashState {
    return {
      now_ms: this.now_ms,
      state_version: this.state_version,
      orders: [...this.orders.values()]
        .filter((o) => o.arrived)
        .map((o) => ({
          id: o.id,
          arrived_at_ms: o.arrived_at_ms,
          items: o.items.map((it) => ({ item_id: it.item_id, quantity: it.quantity })),
          value_minor: o.value_minor,
          status: o.status,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      lots: [...this.lots.values()]
        .map((l) => ({ ...l }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      tasks: [...this.tasks.values()]
        .map((t) => ({ ...t }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      stations: this.stationIds
        .slice()
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((id) => ({ id, task_id: this.occupancy.get(id) ?? null })),
      revenue_minor: this.revenue_minor,
      pending_wake_at_ms: this.pending_wake_at_ms,
      deliveries: [...this.deliveries]
        .map((d) => ({
          delivery_id: d.delivery_id,
          order_id: d.order_id,
          at_ms: d.at_ms,
          value_minor: d.value_minor,
        }))
        .sort((a, b) =>
          a.delivery_id < b.delivery_id ? -1 : a.delivery_id > b.delivery_id ? 1 : 0,
        ),
    };
  }

  private finish(): RunOutput {
    const stateHash = computeStateHash(this.hashState());
    const delivered = this.deliveries.length;
    const status: RunStatus = this.failure === null ? "completed" : "candidate_failed";
    const score_minor: UInt | null = this.failure === null ? this.revenue_minor : 0;
    this.emit(
      "run_finished",
      {
        status,
        score_minor,
        revenue_minor: this.revenue_minor,
        delivered_orders: delivered,
        state_hash: stateHash,
      },
      false,
    );
    const result: EndResult = {
      status,
      score_minor,
      revenue_minor: this.revenue_minor,
      delivered_orders: delivered,
      failure_code: this.failure,
      final_action_results: this.final_action_results.map((r) => ({ ...r })),
      final_wake_result: this.final_wake_result === null ? null : { ...this.final_wake_result },
    };
    return {
      result,
      events: this.events,
      stateHash,
      stats: {
        decisions: this.decisions,
        totalActions: this.total_actions,
        decisionWallMs: this.decision_wall_ms,
      },
    };
  }

  /* ------------------------- conservation -------------------------- */

  /**
   * Doc 02 §11, per item: produced = production inputs + deliveries + on hand.
   * Exhausted lots keep a zero quantity in the ledger, so the identity holds
   * for tasks that never completed before the deadline too.
   */
  check_conservation(): void {
    const onHand = new Map<Id, number>();
    for (const lot of this.lots.values()) {
      if (lot.quantity < 0) {
        throw new Error(`conservation: lot ${lot.id} has negative quantity ${lot.quantity}`);
      }
      if (lot.quantity > 0) {
        onHand.set(lot.item_id, (onHand.get(lot.item_id) ?? 0) + lot.quantity);
      }
    }
    for (const [item_id, produced] of this.produced_total) {
      const used = (this.consumed_by_production.get(item_id) ?? 0) + (this.consumed_by_delivery.get(item_id) ?? 0);
      const left = onHand.get(item_id) ?? 0;
      if (produced !== used + left) {
        throw new Error(
          `conservation violated for ${item_id}: produced ${produced} != used ${used} + on hand ${left}`,
        );
      }
    }
    for (const [item_id, produced] of onHand) {
      if ((this.produced_total.get(item_id) ?? 0) < produced) {
        throw new Error(`conservation: item ${item_id} has unaccounted stock`);
      }
    }
  }

  /** Test/diagnostics accessor for the virtual raw-material ledger. */
  rawConsumption(): Record<Id, number> {
    return Object.fromEntries([...this.raw_consumed.entries()].sort());
  }
}

function sameItemQty(
  required: ReadonlyMap<Id, number>,
  provided: ReadonlyMap<Id, number>,
): boolean {
  if (required.size !== provided.size) return false;
  for (const [item_id, need] of required) {
    if (provided.get(item_id) !== need) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function runScenario(opts: RunOptions): RunOutput {
  return new Kernel(opts).run();
}
