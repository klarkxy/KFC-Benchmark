import { describe, expect, it } from "vitest";

import {
  EASY_KITCHEN,
  KITCHENS,
  MAX_BATCHES_CAP,
  MEDIUM_KITCHEN,
  buildEasyKitchen,
  buildMediumKitchen,
  getCalibration,
} from "../src/kitchens.js";
import { ID_PATTERN, validatePublicConfig } from "../src/validate.js";

/** Deep clone so a fixture mutation cannot leak into another test. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const validBase = buildMediumKitchen();

describe("generated kitchens pass the loader", () => {
  for (const kitchen of KITCHENS) {
    it(`${kitchen.calibration.scenario_id} is valid`, () => {
      expect(validatePublicConfig(kitchen.config)).toEqual([]);
    });
  }

  it("builders are deterministic and independent of the cached constant", () => {
    expect(clone(buildMediumKitchen())).toEqual(clone(MEDIUM_KITCHEN.config));
    expect(clone(buildEasyKitchen())).toEqual(clone(EASY_KITCHEN.config));
  });
});

describe("scenario envelope", () => {
  it("uses protocol 0.3.0-web and the frozen rules/limits", () => {
    expect(validBase.protocol_version).toBe("0.3.0-web");
    expect(validBase.rules).toEqual({
      clock: "paused_code",
      settlement: "whole_order",
      batch_timing: "fixed_within_capacity",
      finish_at_deadline_counts: true,
      delivery_duration_ms: 0,
      cancellation: "unsupported",
    });
    expect(validBase.limits).toEqual({
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
    });
    expect(validBase.currency_unit).toBe("credit_minor");
    expect(validBase.currency_scale).toBe(100);
    expect(validBase.end_at_ms).toBe(300_000);
  });

  it("scenarios carry the documented ids and versions", () => {
    expect(MEDIUM_KITCHEN.config.scenario_id).toBe("medium-01");
    expect(MEDIUM_KITCHEN.config.scenario_version).toBe("1");
    expect(MEDIUM_KITCHEN.config.difficulty).toBe("medium");
    expect(EASY_KITCHEN.config.difficulty).toBe("easy");
    expect(getCalibration("medium-01")).toBe(MEDIUM_KITCHEN.calibration);
    expect(getCalibration("nope")).toBeUndefined();
  });
});

describe("medium tier shape (doc 01 §4)", () => {
  const medium = MEDIUM_KITCHEN.config;

  it("has 8 orderable products and 9 stations", () => {
    expect(medium.items.filter((i) => i.orderable)).toHaveLength(8);
    expect(medium.stations).toHaveLength(9);
  });

  it("implements the chicken -> burger/wrap chain with shared equipment", () => {
    const byId = (id: string) => medium.recipes.find((r) => r.id === id);
    expect(byId("r.marinate")?.inputs).toEqual([{ item_id: "it.chicken_raw", quantity: 1 }]);
    expect(byId("r.bread")?.outputs).toEqual([{ item_id: "it.chicken_breaded", quantity: 1 }]);
    expect(byId("r.fry_patty")?.outputs).toEqual([{ item_id: "it.patty_fried", quantity: 1 }]);

    // patty reaches both a burger base and a wrap base
    expect(byId("r.build_burger")?.inputs.map((q) => q.item_id)).toContain("it.patty_fried");
    expect(byId("r.build_wrap")?.inputs.map((q) => q.item_id)).toContain("it.patty_fried");

    // buns and wrap skins share the heaters
    const heaterStations = new Set(["st.heater_a", "st.heater_b"]);
    expect(new Set(byId("r.heat_bun")?.station_options.map((o) => o.station_id))).toEqual(heaterStations);
    expect(new Set(byId("r.heat_skin")?.station_options.map((o) => o.station_id))).toEqual(heaterStations);

    // fries and patties share the fryers
    const fryerStations = new Set(["st.fryer_a", "st.fryer_b"]);
    expect(new Set(byId("r.fry_patty")?.station_options.map((o) => o.station_id))).toEqual(fryerStations);
    expect(new Set(byId("r.fry_fries")?.station_options.map((o) => o.station_id))).toEqual(fryerStations);

    // final packaging is a single shared capacity-constrained station
    const packagers = new Set(
      medium.recipes
        .filter((r) => r.id.startsWith("r.pack_"))
        .flatMap((r) => r.station_options.map((o) => o.station_id)),
    );
    expect(packagers).toEqual(new Set(["st.packager"]));
  });

  it("has a 5-step longest chain and shared intermediates", () => {
    // raw -> marinated -> breaded -> patty -> burger_base -> burger_classic
    const recipesByOutput = new Map<string, typeof medium.recipes[number]>();
    for (const recipe of medium.recipes) {
      for (const out of recipe.outputs) {
        if (!recipesByOutput.has(out.item_id)) recipesByOutput.set(out.item_id, recipe);
      }
    }
    /** Steps of processing needed to obtain `item`; 0 for a raw item. */
    const depthOf = (item: string): number => {
      const producer = recipesByOutput.get(item);
      if (!producer) return 0;
      return 1 + Math.max(...producer.inputs.map((q) => depthOf(q.item_id)));
    };
    expect(depthOf("p.burger_classic")).toBe(5);
    expect(depthOf("p.fries")).toBe(2);
    // medium tier is defined as a 3–5 step longest chain
    const longest = medium.items
      .filter((i) => i.orderable)
      .reduce((max, i) => Math.max(max, depthOf(i.id)), 0);
    expect(longest).toBeGreaterThanOrEqual(3);
    expect(longest).toBeLessThanOrEqual(5);

    // patty_fried is the shared intermediate: direct consumers are the two
    // assembly recipes, but it reaches most of the catalogue transitively.
    const pattyConsumers = medium.recipes.filter((r) => r.inputs.some((q) => q.item_id === "it.patty_fried"));
    expect(pattyConsumers.map((r) => r.id).sort()).toEqual(["r.build_burger", "r.build_wrap"]);

    const downstream = new Set<string>(["it.patty_fried"]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const recipe of medium.recipes) {
        if (!recipe.inputs.some((q) => downstream.has(q.item_id))) continue;
        for (const out of recipe.outputs) {
          if (!downstream.has(out.item_id)) {
            downstream.add(out.item_id);
            grew = true;
          }
        }
      }
    }
    const pattyBackedProducts = medium.items.filter((i) => i.orderable && downstream.has(i.id));
    expect(pattyBackedProducts.length).toBeGreaterThanOrEqual(6);
    // only the plain fries product avoids the patty line entirely
    expect(medium.items.filter((i) => i.orderable && !downstream.has(i.id)).map((i) => i.id)).toEqual(["p.fries"]);
  });

  it("offers alternative stations that differ in duration and max_batches", () => {
    const fry = medium.recipes.find((r) => r.id === "r.fry_patty");
    expect(fry?.station_options).toHaveLength(2);
    const [a, b] = fry?.station_options ?? [];
    expect(a?.duration_ms).not.toBe(b?.duration_ms);
    expect(a?.max_batches).not.toBe(b?.max_batches);
  });

  it("prices are not proportional to processing time", () => {
    const price = new Map(medium.items.map((i) => [i.id, i.price_minor]));
    // Fries is the cheapest product but by far the shortest critical path, so a
    // per-second price ratio must not be constant across the catalogue.
    const ratio = (id: string, chainMs: number) => (price.get(id) ?? 0) / chainMs;
    expect(ratio("p.fries", 4_000 + 1_200 + 1_500)).toBeGreaterThan(ratio("p.burger_classic", 6_000 + 5_000 + 9_000 + 2_500 + 3_000 + 2_000));
    expect(ratio("p.meal_burger", 6_000 + 5_000 + 9_000 + 2_500 + 3_000 + 4_500 + 1_200 + 1_800 + 2_800)).toBeGreaterThan(
      ratio("p.wrap_classic", 6_000 + 5_000 + 9_000 + 2_200 + 2_500 + 1_200 + 1_800),
    );
  });

  it("has no single dominant product per unit of demand", () => {
    const prices = medium.items.filter((i) => i.orderable).map((i) => i.price_minor);
    const max = Math.max(...prices);
    const min = Math.min(...prices);
    // The priciest item must not also be within reach of the cheapest, so no
    // one line is a strictly better buy under every mix.
    expect(max / min).toBeGreaterThan(3);
  });
});

describe("easy tier shape (doc 01 §4)", () => {
  const easy = EASY_KITCHEN.config;

  it("has 4 products, 5 stations and 2–3 step chains", () => {
    expect(easy.items.filter((i) => i.orderable)).toHaveLength(4);
    expect(easy.stations).toHaveLength(5);
    const byId = (id: string) => easy.recipes.find((r) => r.id === id);
    // raw -> grilled -> sandwich base -> product
    expect(byId("r.grill_chicken")?.inputs).toEqual([{ item_id: "it.chicken_raw", quantity: 1 }]);
    expect(byId("r.assemble_grilled")?.inputs).toHaveLength(2);
    expect(byId("r.pack_grilled_sandwich")?.station_options[0]?.station_id).toBe("st.packager");
  });
});

describe("structural invariants", () => {
  it("every id matches the id pattern", () => {
    for (const kitchen of KITCHENS) {
      const ids = [
        ...kitchen.config.items.map((i) => i.id),
        ...kitchen.config.recipes.map((r) => r.id),
        ...kitchen.config.stations.map((s) => s.id),
        ...kitchen.config.recipes.flatMap((r) => r.station_options.map((o) => o.station_id)),
        kitchen.config.scenario_id,
      ];
      for (const id of ids) expect(id).toMatch(ID_PATTERN);
    }
  });

  it("unlimited_raw is never orderable, never priced and never a recipe output", () => {
    for (const kitchen of KITCHENS) {
      const raw = new Set(kitchen.config.items.filter((i) => i.supply === "unlimited_raw").map((i) => i.id));
      for (const item of kitchen.config.items) {
        if (raw.has(item.id)) {
          expect(item.orderable).toBe(false);
          expect(item.price_minor).toBe(0);
        }
      }
      for (const recipe of kitchen.config.recipes) {
        for (const out of recipe.outputs) expect(raw.has(out.item_id)).toBe(false);
      }
      expect(raw.size).toBeGreaterThan(0);
    }
  });

  it("batch limits stay inside the schema bound", () => {
    for (const kitchen of KITCHENS) {
      for (const recipe of kitchen.config.recipes) {
        for (const option of recipe.station_options) {
          expect(option.max_batches).toBeGreaterThanOrEqual(1);
          expect(option.max_batches).toBeLessThanOrEqual(MAX_BATCHES_CAP);
          expect(option.duration_ms).toBeGreaterThan(0);
        }
      }
    }
  });
});
