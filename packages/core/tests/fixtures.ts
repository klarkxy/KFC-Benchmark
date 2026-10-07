import type {
  Action,
  ActionResult,
  ControllerModule,
  Decision,
  EventRecord,
  EventType,
  Limits,
  Observation,
  Order,
  PublicConfig,
} from "@kitchensched/contracts";

/* ------------------------------------------------------------------ *
 * Scenario fixture
 *
 *   s1, s2  grills   -> r_burger   (bun + patty  -> burger)
 *   s3      fryer   -> r_fries    (potato       -> fries)
 *   s4, s5  prep    -> r_patty    (meat         -> patty)
 * ------------------------------------------------------------------ */

export const BASE_LIMITS: Limits = {
  init_wall_ms: 5_000,
  decision_wall_ms: 2_000,
  total_cpu_ms: 30_000,
  memory_mib: 256,
  max_decisions: 20_000,
  max_actions_per_decision: 1_024,
  max_total_actions: 200_000,
  min_wake_delay_ms: 20,
  max_message_bytes: 4_194_304,
  max_stderr_bytes: 1_048_576,
  max_pids: 1,
  max_writable_mib: 1,
  max_orders_per_run: 1_000,
};

export interface FixtureOptions {
  end_at_ms?: number;
  limits?: Partial<Limits>;
  /** duration_ms of the r_burger option on s1 (default 1000). */
  s1_ms?: number;
  /** duration_ms of the r_burger option on s2 (default 1500). */
  s2_ms?: number;
  /** duration_ms of the r_fries option on s3 (default 800). */
  s3_ms?: number;
  /** duration_ms of the r_patty option on s4/s5 (default 500). */
  prep_ms?: number;
  /** max_batches of the r_burger option on s1 (default 2). */
  s1_max_batches?: number;
  /** max_batches of the r_fries option on s3 (default 4). */
  s3_max_batches?: number;
  /** Rename display fields to prove they never reach the state hash. */
  names?: string;
}

const PRICES: Record<string, number> = { burger: 500, fries: 300, burger2: 800 };

export function makeConfig(options: FixtureOptions = {}): PublicConfig {
  const s1_ms = options.s1_ms ?? 1_000;
  const s2_ms = options.s2_ms ?? 1_500;
  const s3_ms = options.s3_ms ?? 800;
  const prep_ms = options.prep_ms ?? 500;
  const tag = options.names === undefined ? "" : `${options.names}:`;
  return {
    protocol_version: "0.3.0-web",
    scenario_id: "fixture",
    scenario_version: "1.0.0",
    difficulty: "easy",
    end_at_ms: options.end_at_ms ?? 5_000,
    currency_unit: "credit_minor",
    currency_scale: 100,
    items: [
      { id: "bun", name: `${tag}bun`, supply: "unlimited_raw", orderable: false, price_minor: 0 },
      { id: "meat", name: `${tag}meat`, supply: "unlimited_raw", orderable: false, price_minor: 0 },
      { id: "potato", name: `${tag}potato`, supply: "unlimited_raw", orderable: false, price_minor: 0 },
      { id: "patty", name: `${tag}patty`, supply: "produced", orderable: false, price_minor: 0 },
      { id: "burger", name: `${tag}burger`, supply: "produced", orderable: true, price_minor: 500 },
      { id: "burger2", name: `${tag}burger2`, supply: "produced", orderable: true, price_minor: 800 },
      { id: "fries", name: `${tag}fries`, supply: "produced", orderable: true, price_minor: 300 },
    ],
    recipes: [
      {
        id: "r_burger",
        name: `${tag}burger`,
        inputs: [
          { item_id: "bun", quantity: 1 },
          { item_id: "patty", quantity: 1 },
        ],
        outputs: [{ item_id: "burger", quantity: 1 }],
        station_options: [
          { station_id: "s1", duration_ms: s1_ms, max_batches: options.s1_max_batches ?? 2 },
          { station_id: "s2", duration_ms: s2_ms, max_batches: 3 },
        ],
      },
      {
        id: "r_fries",
        name: `${tag}fries`,
        inputs: [{ item_id: "potato", quantity: 1 }],
        outputs: [{ item_id: "fries", quantity: 1 }],
        station_options: [
          { station_id: "s3", duration_ms: s3_ms, max_batches: options.s3_max_batches ?? 4 },
        ],
      },
      {
        id: "r_patty",
        name: `${tag}patty`,
        inputs: [{ item_id: "meat", quantity: 1 }],
        outputs: [{ item_id: "patty", quantity: 1 }],
        station_options: [
          { station_id: "s4", duration_ms: prep_ms, max_batches: 2 },
          { station_id: "s5", duration_ms: prep_ms, max_batches: 2 },
        ],
      },
    ],
    stations: [
      { id: "s1", kind: "grill", name: `${tag}grill-1` },
      { id: "s2", kind: "grill", name: `${tag}grill-2` },
      { id: "s3", kind: "fryer", name: `${tag}fryer` },
      { id: "s4", kind: "prep", name: `${tag}prep-1` },
      { id: "s5", kind: "prep", name: `${tag}prep-2` },
    ],
    rules: {
      clock: "paused_code",
      settlement: "whole_order",
      batch_timing: "fixed_within_capacity",
      finish_at_deadline_counts: true,
      delivery_duration_ms: 0,
      cancellation: "unsupported",
    },
    limits: { ...BASE_LIMITS, ...options.limits },
  };
}

/** Order helper; value_minor is recomputed from config prices unless forced. */
export function order(
  id: string,
  arrived_at_ms: number,
  items: [string, number][],
  value_minor?: number,
): Order {
  const value = value_minor ?? items.reduce((sum, [id_, qty]) => sum + (PRICES[id_] ?? 0) * qty, 0);
  return {
    id,
    arrived_at_ms,
    items: items.map(([item_id, quantity]) => ({ item_id, quantity })),
    value_minor: value,
  };
}

/* ------------------------------------------------------------------ *
 * Action builders
 * ------------------------------------------------------------------ */

export function start(
  action_id: string,
  recipe_id: string,
  station_id: string,
  batches = 1,
  input_lots: [string, number][] = [],
): Action {
  return {
    type: "start",
    action_id,
    recipe_id,
    station_id,
    batches,
    input_lots: input_lots.map(([lot_id, quantity]) => ({ lot_id, quantity })),
  };
}

export function deliver(
  action_id: string,
  order_id: string,
  output_lots: [string, number][],
): Action {
  return {
    type: "deliver",
    action_id,
    order_id,
    output_lots: output_lots.map(([lot_id, quantity]) => ({ lot_id, quantity })),
  };
}

export function dec(actions: Action[] = [], wake_at_ms: number | null = null): Decision {
  return { actions, wake_at_ms };
}

/* ------------------------------------------------------------------ *
 * Event stream helpers
 * ------------------------------------------------------------------ */

export function eventsOf<T extends EventType>(events: EventRecord[], type: T): EventRecord<T>[] {
  return events.filter((ev) => ev.type === type) as EventRecord<T>[];
}

export function eventTypes(events: EventRecord[]): string[] {
  return events.map((ev) => ev.type);
}

/** The results of the decision made on call `call` surface in the next observe. */
export function resultsForCall(c: RecordingController, call: number): ActionResult[] {
  return c.observations[call + 1]?.previous_results ?? [];
}

/** The observe handed to the decision of call `call`. */
export function observeAt(c: RecordingController, call: number): Observation | undefined {
  return c.observations[call];
}

export function nowSeq(c: RecordingController): number[] {
  return c.observations.map((o) => o.now_ms);
}

/* ------------------------------------------------------------------ *
 * Test controllers
 * ------------------------------------------------------------------ */

export interface RecordingController extends ControllerModule {
  readonly observations: Observation[];
  readonly initConfigs: PublicConfig[];
  readonly seeds: number[];
  readonly randoms: number[];
}

/**
 * A controller driven by a plan. The plan may return a `Decision` or any raw
 * value, which lets the malformed-response cases run through the real kernel.
 */
export function controller(
  plan: (observation: Observation, call: number) => unknown,
  onInit?: (controller: RecordingController) => void,
): RecordingController {
  const observations: Observation[] = [];
  const initConfigs: PublicConfig[] = [];
  const seeds: number[] = [];
  const randoms: number[] = [];
  let call = 0;
  const self: RecordingController = {
    observations,
    initConfigs,
    seeds,
    randoms,
    init(config, ctx) {
      initConfigs.push(config);
      seeds.push(ctx.policy_seed);
      randoms.push(ctx.random(), ctx.random());
      onInit?.(self);
    },
    decide(observation) {
      observations.push(observation);
      return plan(observation, call++) as Decision;
    },
  };
  return self;
}

/** Serves a queue of decisions by call index, then idles. */
export function scripted(plan: Decision[], onInit?: (c: RecordingController) => void): RecordingController {
  return controller((_observation, call) => plan[call] ?? dec(), onInit);
}

/** Always answers with an empty response. */
export function idle(): RecordingController {
  return controller(() => dec());
}

/** Hand-rolled wall clock so decision timeouts are deterministic. */
export class FakeClock {
  t = 0;
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}
