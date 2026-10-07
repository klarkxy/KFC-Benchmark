/**
 * KitchenSched scenario kitchen definitions.
 *
 * Every tunable number for a kitchen — prices, durations, batch sizes,
 * station counts, demand weights — lives in exactly one `CALIBRATION` block
 * below. The builders are pure projections from calibration data to the
 * frozen `PublicConfig` shape, so retuning a kitchen is a one-place edit.
 *
 * Design intent (doc 01 §4/§5, doc 02 §12):
 *  - prices are NOT proportional to processing time;
 *  - no single product is the right answer for every demand mix;
 *  - medium tier has shared intermediates, equipment contention, batch
 *    capacity plays, and at least one recipe with alternative stations whose
 *    duration AND max_batches differ.
 */

import {
  PROTOCOL_VERSION,
  type Difficulty,
  type Id,
  type ItemQty,
  type Limits,
  type PublicConfig,
  type Rules,
  type StationOption,
  type Supply,
  type UInt,
} from "@kitchensched/contracts";

/* ------------------------------------------------------------------------ */
/* Shared mechanical constants (identical for every 0.3.0-web scenario)     */
/* ------------------------------------------------------------------------ */

/** Doc 03 §7 initial calibration values. */
export const INITIAL_LIMITS: Limits = {
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
  max_pids: 64,
  max_writable_mib: 64,
  max_orders_per_run: 1_024,
};

export const FIXED_RULES: Rules = {
  clock: "paused_code",
  settlement: "whole_order",
  batch_timing: "fixed_within_capacity",
  finish_at_deadline_counts: true,
  delivery_duration_ms: 0,
  cancellation: "unsupported",
};

/** Largest value any single unit of an item may carry (doc 02 §1). */
export const MAX_AMOUNT = 9_007_199_254_740_991;

/** public-scenario.schema.json bounds `StationOption.max_batches` at 128. */
export const MAX_BATCHES_CAP = 128;

/* ------------------------------------------------------------------------ */
/* Calibration data shapes                                                  */
/* ------------------------------------------------------------------------ */

export interface StationCal {
  readonly id: Id;
  readonly kind: string;
  readonly name: string;
}

export interface ItemCal {
  readonly id: Id;
  readonly name: string;
  readonly supply: Supply;
  readonly orderable: boolean;
  readonly price_minor: UInt;
}

export interface RecipeCal {
  readonly id: Id;
  readonly name: string;
  readonly inputs: readonly ItemQty[];
  readonly outputs: readonly ItemQty[];
  readonly station_options: readonly StationOption[];
}

/** Demand-mix calibration consumed by `src/stream.ts`. */
export interface DemandCal {
  /** Weight of an order with exactly 1 line, then 2 lines, … */
  readonly line_count_weights: readonly number[];
  /** Weight of quantity 1, then quantity 2, … */
  readonly quantity_weights: readonly number[];
}

export interface ArrivalCal {
  readonly interval_ms: number;
  readonly start_at_ms: number;
}

export interface KitchenCal {
  readonly scenario_id: Id;
  readonly scenario_version: string;
  readonly difficulty: Difficulty;
  /** Prep (60s) + business (240s) is one continuous simulation. */
  readonly end_at_ms: number;
  readonly stations: readonly StationCal[];
  readonly items: readonly ItemCal[];
  readonly recipes: readonly RecipeCal[];
  readonly demand: DemandCal;
  readonly arrivals: ArrivalCal;
}

/* ========================================================================== */
/* CALIBRATION — medium-01                                                  */
/* ========================================================================== */
/*
 * Chain: chicken -> marinated -> breaded -> fried patty
 *        patty -> burger base | wrap base  (assembly)
 *        base + garnish -> sealed orderable product (packaging)
 * Shared:   buns and wrap skins share the heaters;
 *           fries and patties share the fryers;
 *           the single packager is the final capacity constraint.
 */
const MEDIUM_CALIBRATION: KitchenCal = {
  scenario_id: "medium-01",
  scenario_version: "1",
  difficulty: "medium",
  end_at_ms: 300_000,

  // --- 9 stations (doc 01 §4: medium starts at 8–10) ---------------------
  stations: [
    { id: "st.marinator", kind: "marinade", name: "Marinator" },
    { id: "st.breader", kind: "breading", name: "Breader" },
    { id: "st.fryer_a", kind: "fryer", name: "Fryer A" },
    { id: "st.fryer_b", kind: "fryer", name: "Fryer B" },
    { id: "st.heater_a", kind: "heater", name: "Heater A" },
    { id: "st.heater_b", kind: "heater", name: "Heater B" },
    { id: "st.assembler", kind: "assembly", name: "Assembler" },
    { id: "st.dispenser", kind: "dispenser", name: "Dispenser" },
    { id: "st.packager", kind: "packaging", name: "Packager" },
  ],

  // --- 24 items: 6 raw, 10 produced intermediates, 8 orderable -----------
  items: [
    // unlimited_raw: never orderable, never a recipe output, price 0.
    { id: "it.chicken_raw", name: "Chicken Breast", supply: "unlimited_raw", orderable: false, price_minor: 0 },
    { id: "it.bun_raw", name: "Burger Bun", supply: "unlimited_raw", orderable: false, price_minor: 0 },
    { id: "it.skin_raw", name: "Wrap Skin", supply: "unlimited_raw", orderable: false, price_minor: 0 },
    { id: "it.fry_raw", name: "Frozen Fries", supply: "unlimited_raw", orderable: false, price_minor: 0 },
    { id: "it.sauce_raw", name: "Sauce Cup Stock", supply: "unlimited_raw", orderable: false, price_minor: 0 },
    { id: "it.drink_raw", name: "Drink Syrup", supply: "unlimited_raw", orderable: false, price_minor: 0 },

    // produced intermediates.
    { id: "it.chicken_marinated", name: "Marinated Chicken", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.chicken_breaded", name: "Breaded Chicken", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.patty_fried", name: "Fried Chicken Patty", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.bun_hot", name: "Toasted Bun", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.skin_hot", name: "Warmed Wrap Skin", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.fries_fried", name: "Fried Fries", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.sauce_cup", name: "Portioned Sauce", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.drink_cup", name: "Poured Drink", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.burger_base", name: "Burger Base", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.wrap_base", name: "Wrap Base", supply: "produced", orderable: false, price_minor: 0 },

    // orderable products. Prices are credit_minor (scale 100).
    { id: "p.burger_classic", name: "Classic Burger", supply: "produced", orderable: true, price_minor: 1_150 },
    { id: "p.burger_double", name: "Double Burger", supply: "produced", orderable: true, price_minor: 1_690 },
    { id: "p.burger_trio", name: "Trio Burger", supply: "produced", orderable: true, price_minor: 2_190 },
    { id: "p.wrap_classic", name: "Classic Wrap", supply: "produced", orderable: true, price_minor: 990 },
    { id: "p.wrap_double", name: "Double Wrap", supply: "produced", orderable: true, price_minor: 1_490 },
    { id: "p.fries", name: "Fries", supply: "produced", orderable: true, price_minor: 480 },
    { id: "p.meal_burger", name: "Burger Meal", supply: "produced", orderable: true, price_minor: 2_180 },
    { id: "p.meal_wrap", name: "Wrap Meal", supply: "produced", orderable: true, price_minor: 2_080 },
  ],

  // --- 18 recipes; longest chain 5 steps (raw -> ... -> sealed product) ----
  recipes: [
    {
      id: "r.marinate",
      name: "Marinate Chicken",
      inputs: [{ item_id: "it.chicken_raw", quantity: 1 }],
      outputs: [{ item_id: "it.chicken_marinated", quantity: 1 }],
      station_options: [{ station_id: "st.marinator", duration_ms: 6_000, max_batches: 4 }],
    },
    {
      id: "r.bread",
      name: "Bread Chicken",
      inputs: [{ item_id: "it.chicken_marinated", quantity: 1 }],
      outputs: [{ item_id: "it.chicken_breaded", quantity: 1 }],
      station_options: [{ station_id: "st.breader", duration_ms: 5_000, max_batches: 3 }],
    },
    {
      // Alternative stations: same recipe, different duration AND capacity.
      id: "r.fry_patty",
      name: "Fry Chicken Patty",
      inputs: [{ item_id: "it.chicken_breaded", quantity: 1 }],
      outputs: [{ item_id: "it.patty_fried", quantity: 1 }],
      station_options: [
        { station_id: "st.fryer_a", duration_ms: 9_000, max_batches: 4 },
        { station_id: "st.fryer_b", duration_ms: 12_000, max_batches: 2 },
      ],
    },
    {
      id: "r.fry_fries",
      name: "Fry Fries",
      inputs: [{ item_id: "it.fry_raw", quantity: 1 }],
      outputs: [{ item_id: "it.fries_fried", quantity: 1 }],
      station_options: [
        { station_id: "st.fryer_a", duration_ms: 4_500, max_batches: 6 },
        { station_id: "st.fryer_b", duration_ms: 4_000, max_batches: 8 },
      ],
    },
    {
      id: "r.heat_bun",
      name: "Toast Bun",
      inputs: [{ item_id: "it.bun_raw", quantity: 1 }],
      outputs: [{ item_id: "it.bun_hot", quantity: 1 }],
      station_options: [
        { station_id: "st.heater_a", duration_ms: 2_500, max_batches: 4 },
        { station_id: "st.heater_b", duration_ms: 3_200, max_batches: 2 },
      ],
    },
    {
      id: "r.heat_skin",
      name: "Warm Wrap Skin",
      inputs: [{ item_id: "it.skin_raw", quantity: 1 }],
      outputs: [{ item_id: "it.skin_hot", quantity: 1 }],
      station_options: [
        { station_id: "st.heater_a", duration_ms: 2_200, max_batches: 3 },
        { station_id: "st.heater_b", duration_ms: 2_400, max_batches: 3 },
      ],
    },
    {
      id: "r.portion_sauce",
      name: "Portion Sauce",
      inputs: [{ item_id: "it.sauce_raw", quantity: 1 }],
      outputs: [{ item_id: "it.sauce_cup", quantity: 1 }],
      station_options: [{ station_id: "st.dispenser", duration_ms: 1_200, max_batches: 8 }],
    },
    {
      id: "r.pour_drink",
      name: "Pour Drink",
      inputs: [{ item_id: "it.drink_raw", quantity: 1 }],
      outputs: [{ item_id: "it.drink_cup", quantity: 1 }],
      station_options: [{ station_id: "st.dispenser", duration_ms: 1_800, max_batches: 6 }],
    },
    {
      id: "r.build_burger",
      name: "Assemble Burger Base",
      inputs: [
        { item_id: "it.patty_fried", quantity: 1 },
        { item_id: "it.bun_hot", quantity: 1 },
      ],
      outputs: [{ item_id: "it.burger_base", quantity: 1 }],
      station_options: [{ station_id: "st.assembler", duration_ms: 3_000, max_batches: 4 }],
    },
    {
      id: "r.build_wrap",
      name: "Assemble Wrap Base",
      inputs: [
        { item_id: "it.patty_fried", quantity: 1 },
        { item_id: "it.skin_hot", quantity: 1 },
      ],
      outputs: [{ item_id: "it.wrap_base", quantity: 1 }],
      station_options: [{ station_id: "st.assembler", duration_ms: 2_500, max_batches: 4 }],
    },

    // Final packaging: one shared packager whose per-recipe max_batches is
    // the throughput ceiling for the whole kitchen.
    {
      id: "r.pack_burger_classic",
      name: "Pack Classic Burger",
      inputs: [
        { item_id: "it.burger_base", quantity: 1 },
        { item_id: "it.sauce_cup", quantity: 1 },
      ],
      outputs: [{ item_id: "p.burger_classic", quantity: 1 }],
      station_options: [{ station_id: "st.packager", duration_ms: 2_000, max_batches: 4 }],
    },
    {
      id: "r.pack_burger_double",
      name: "Pack Double Burger",
      inputs: [
        { item_id: "it.burger_base", quantity: 2 },
        { item_id: "it.sauce_cup", quantity: 1 },
      ],
      outputs: [{ item_id: "p.burger_double", quantity: 1 }],
      station_options: [{ station_id: "st.packager", duration_ms: 2_600, max_batches: 3 }],
    },
    {
      id: "r.pack_burger_trio",
      name: "Pack Trio Burger",
      inputs: [
        { item_id: "it.burger_base", quantity: 3 },
        { item_id: "it.sauce_cup", quantity: 2 },
      ],
      outputs: [{ item_id: "p.burger_trio", quantity: 1 }],
      station_options: [{ station_id: "st.packager", duration_ms: 3_200, max_batches: 2 }],
    },
    {
      id: "r.pack_wrap_classic",
      name: "Pack Classic Wrap",
      inputs: [
        { item_id: "it.wrap_base", quantity: 1 },
        { item_id: "it.sauce_cup", quantity: 1 },
      ],
      outputs: [{ item_id: "p.wrap_classic", quantity: 1 }],
      station_options: [{ station_id: "st.packager", duration_ms: 1_800, max_batches: 4 }],
    },
    {
      id: "r.pack_wrap_double",
      name: "Pack Double Wrap",
      inputs: [
        { item_id: "it.wrap_base", quantity: 2 },
        { item_id: "it.sauce_cup", quantity: 1 },
      ],
      outputs: [{ item_id: "p.wrap_double", quantity: 1 }],
      station_options: [{ station_id: "st.packager", duration_ms: 2_400, max_batches: 3 }],
    },
    {
      id: "r.pack_fries",
      name: "Pack Fries",
      inputs: [
        { item_id: "it.fries_fried", quantity: 1 },
        { item_id: "it.sauce_cup", quantity: 1 },
      ],
      outputs: [{ item_id: "p.fries", quantity: 1 }],
      station_options: [{ station_id: "st.packager", duration_ms: 1_500, max_batches: 6 }],
    },
    {
      id: "r.pack_meal_burger",
      name: "Pack Burger Meal",
      inputs: [
        { item_id: "it.burger_base", quantity: 1 },
        { item_id: "it.fries_fried", quantity: 1 },
        { item_id: "it.sauce_cup", quantity: 1 },
        { item_id: "it.drink_cup", quantity: 1 },
      ],
      outputs: [{ item_id: "p.meal_burger", quantity: 1 }],
      station_options: [{ station_id: "st.packager", duration_ms: 2_800, max_batches: 2 }],
    },
    {
      id: "r.pack_meal_wrap",
      name: "Pack Wrap Meal",
      inputs: [
        { item_id: "it.wrap_base", quantity: 1 },
        { item_id: "it.fries_fried", quantity: 1 },
        { item_id: "it.sauce_cup", quantity: 1 },
        { item_id: "it.drink_cup", quantity: 1 },
      ],
      outputs: [{ item_id: "p.meal_wrap", quantity: 1 }],
      station_options: [{ station_id: "st.packager", duration_ms: 2_600, max_batches: 2 }],
    },
  ],

  // Demand: roughly uniform item choice, bell-shaped basket size.
  demand: {
    line_count_weights: [1, 2, 2, 1], // 1..4 lines, mean 2.5
    quantity_weights: [3, 5, 2], // quantity 1..3, mean 1.75
  },

  // 60s preparation with no orders, then one arrival every 12s until <300s
  // => 20 orders at 60_000 .. 288_000.
  arrivals: { interval_ms: 12_000, start_at_ms: 60_000 },
};

/* ========================================================================== */
/* CALIBRATION — easy-01                                                    */
/* ========================================================================== */
/*
 * Easy tier: 4 orderable products, 5 stations, 3-step chains.
 * Shares: one fryer for chicken and fries, one packager for every product.
 */
const EASY_CALIBRATION: KitchenCal = {
  scenario_id: "easy-01",
  scenario_version: "1",
  difficulty: "easy",
  end_at_ms: 300_000,

  // --- 5 stations (doc 01 §4: easy starts at 4–6) -----------------------
  stations: [
    { id: "st.grill", kind: "grill", name: "Grill" },
    { id: "st.fryer", kind: "fryer", name: "Fryer" },
    { id: "st.oven", kind: "oven", name: "Oven" },
    { id: "st.counter", kind: "assembly", name: "Counter" },
    { id: "st.packager", kind: "packaging", name: "Packager" },
  ],

  // --- 13 items: 3 raw, 6 produced intermediates, 4 orderable -----------
  items: [
    { id: "it.chicken_raw", name: "Chicken Fillet", supply: "unlimited_raw", orderable: false, price_minor: 0 },
    { id: "it.dough_raw", name: "Bun Dough", supply: "unlimited_raw", orderable: false, price_minor: 0 },
    { id: "it.fry_raw", name: "Frozen Fries", supply: "unlimited_raw", orderable: false, price_minor: 0 },

    { id: "it.chicken_grilled", name: "Grilled Fillet", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.chicken_fried", name: "Fried Fillet", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.fries_fried", name: "Fried Fries", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.baked_bun", name: "Baked Bun", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.sandwich_base", name: "Grilled Sandwich Base", supply: "produced", orderable: false, price_minor: 0 },
    { id: "it.crispy_base", name: "Crispy Sandwich Base", supply: "produced", orderable: false, price_minor: 0 },

    { id: "p.grilled_sandwich", name: "Grilled Sandwich", supply: "produced", orderable: true, price_minor: 850 },
    { id: "p.crispy_sandwich", name: "Crispy Sandwich", supply: "produced", orderable: true, price_minor: 950 },
    { id: "p.fries_box", name: "Fries Box", supply: "produced", orderable: true, price_minor: 420 },
    { id: "p.combo_box", name: "Sandwich Combo", supply: "produced", orderable: true, price_minor: 1_520 },
  ],

  // --- 10 recipes; longest chain 3 steps ----------------------------------
  recipes: [
    {
      id: "r.grill_chicken",
      name: "Grill Fillet",
      inputs: [{ item_id: "it.chicken_raw", quantity: 1 }],
      outputs: [{ item_id: "it.chicken_grilled", quantity: 1 }],
      station_options: [{ station_id: "st.grill", duration_ms: 6_000, max_batches: 2 }],
    },
    {
      id: "r.fry_chicken",
      name: "Fry Fillet",
      inputs: [{ item_id: "it.chicken_raw", quantity: 1 }],
      outputs: [{ item_id: "it.chicken_fried", quantity: 1 }],
      station_options: [{ station_id: "st.fryer", duration_ms: 5_000, max_batches: 3 }],
    },
    {
      id: "r.fry_fries",
      name: "Fry Fries",
      inputs: [{ item_id: "it.fry_raw", quantity: 1 }],
      outputs: [{ item_id: "it.fries_fried", quantity: 1 }],
      station_options: [{ station_id: "st.fryer", duration_ms: 4_000, max_batches: 4 }],
    },
    {
      id: "r.bake_bun",
      name: "Bake Bun",
      inputs: [{ item_id: "it.dough_raw", quantity: 1 }],
      outputs: [{ item_id: "it.baked_bun", quantity: 1 }],
      station_options: [{ station_id: "st.oven", duration_ms: 3_000, max_batches: 4 }],
    },
    {
      id: "r.assemble_grilled",
      name: "Assemble Grilled Base",
      inputs: [
        { item_id: "it.chicken_grilled", quantity: 1 },
        { item_id: "it.baked_bun", quantity: 1 },
      ],
      outputs: [{ item_id: "it.sandwich_base", quantity: 1 }],
      station_options: [{ station_id: "st.counter", duration_ms: 2_000, max_batches: 3 }],
    },
    {
      id: "r.assemble_crispy",
      name: "Assemble Crispy Base",
      inputs: [
        { item_id: "it.chicken_fried", quantity: 1 },
        { item_id: "it.baked_bun", quantity: 1 },
      ],
      outputs: [{ item_id: "it.crispy_base", quantity: 1 }],
      station_options: [{ station_id: "st.counter", duration_ms: 2_000, max_batches: 3 }],
    },
    {
      id: "r.pack_grilled_sandwich",
      name: "Pack Grilled Sandwich",
      inputs: [{ item_id: "it.sandwich_base", quantity: 1 }],
      outputs: [{ item_id: "p.grilled_sandwich", quantity: 1 }],
      station_options: [{ station_id: "st.packager", duration_ms: 1_800, max_batches: 3 }],
    },
    {
      id: "r.pack_crispy_sandwich",
      name: "Pack Crispy Sandwich",
      inputs: [{ item_id: "it.crispy_base", quantity: 1 }],
      outputs: [{ item_id: "p.crispy_sandwich", quantity: 1 }],
      station_options: [{ station_id: "st.packager", duration_ms: 1_800, max_batches: 3 }],
    },
    {
      id: "r.pack_fries_box",
      name: "Pack Fries Box",
      inputs: [{ item_id: "it.fries_fried", quantity: 1 }],
      outputs: [{ item_id: "p.fries_box", quantity: 1 }],
      station_options: [{ station_id: "st.packager", duration_ms: 1_500, max_batches: 4 }],
    },
    {
      id: "r.pack_combo_box",
      name: "Pack Sandwich Combo",
      inputs: [
        { item_id: "it.sandwich_base", quantity: 1 },
        { item_id: "it.fries_fried", quantity: 1 },
      ],
      outputs: [{ item_id: "p.combo_box", quantity: 1 }],
      station_options: [{ station_id: "st.packager", duration_ms: 2_400, max_batches: 2 }],
    },
  ],

  demand: {
    line_count_weights: [2, 2, 1], // 1..3 lines, mean 1.67
    quantity_weights: [4, 4, 2], // quantity 1..3, mean 1.67
  },

  // One arrival every 15s => 16 orders at 60_000 .. 285_000.
  arrivals: { interval_ms: 15_000, start_at_ms: 60_000 },
};

/* ------------------------------------------------------------------------ */
/* Builders                                                                 */
/* ------------------------------------------------------------------------ */

export function buildPublicConfig(cal: KitchenCal): PublicConfig {
  return {
    protocol_version: PROTOCOL_VERSION,
    scenario_id: cal.scenario_id,
    scenario_version: cal.scenario_version,
    difficulty: cal.difficulty,
    end_at_ms: cal.end_at_ms,
    currency_unit: "credit_minor",
    currency_scale: 100,
    items: cal.items.map((it) => ({ ...it })),
    recipes: cal.recipes.map((r) => ({
      id: r.id,
      name: r.name,
      inputs: r.inputs.map((q) => ({ ...q })),
      outputs: r.outputs.map((q) => ({ ...q })),
      station_options: r.station_options.map((o) => ({ ...o })),
    })),
    stations: cal.stations.map((s) => ({ ...s })),
    rules: { ...FIXED_RULES },
    limits: { ...INITIAL_LIMITS },
  };
}

export function buildMediumKitchen(): PublicConfig {
  return buildPublicConfig(MEDIUM_CALIBRATION);
}

export function buildEasyKitchen(): PublicConfig {
  return buildPublicConfig(EASY_CALIBRATION);
}

export interface KitchenDefinition {
  readonly calibration: KitchenCal;
  readonly config: PublicConfig;
}

export const MEDIUM_KITCHEN: KitchenDefinition = {
  calibration: MEDIUM_CALIBRATION,
  config: buildPublicConfig(MEDIUM_CALIBRATION),
};

export const EASY_KITCHEN: KitchenDefinition = {
  calibration: EASY_CALIBRATION,
  config: buildPublicConfig(EASY_CALIBRATION),
};

/** Ordered so CLI output is stable. */
export const KITCHENS: readonly KitchenDefinition[] = [MEDIUM_KITCHEN, EASY_KITCHEN];

export function getCalibration(scenario_id: Id): KitchenCal | undefined {
  return KITCHENS.find((k) => k.calibration.scenario_id === scenario_id)?.calibration;
}
