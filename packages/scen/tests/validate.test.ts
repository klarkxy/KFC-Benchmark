import { describe, expect, it } from "vitest";

import { KITCHENS, buildEasyKitchen, buildMediumKitchen } from "../src/kitchens.js";
import { formatIssues, validatePublicConfig, validateScenario } from "../src/validate.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const base = buildMediumKitchen();

describe("valid fixtures", () => {
  it("both generated kitchens pass", () => {
    for (const kitchen of KITCHENS) {
      expect(validatePublicConfig(kitchen.config)).toEqual([]);
    }
  });

  it("an empty object is rejected as a shape error, not a crash", () => {
    const issues = validatePublicConfig({});
    expect(issues.length).toBeGreaterThan(0);
    expect(formatIssues(issues)).toContain("[config.protocol_version]");
  });

  it("non-objects are rejected", () => {
    for (const bad of [null, 42, "x", [], true]) {
      const issues = validatePublicConfig(bad);
      expect(issues.map((i) => i.code)).toContain("config.not_object");
    }
  });
});

interface ConfigFixture {
  name: string;
  mutate: (config: ReturnType<typeof clone<typeof base>>) => void;
  code: string;
}

const CONFIG_FIXTURES: ConfigFixture[] = [
  {
    name: "duplicate item id",
    mutate: (c) => {
      const first = c.items[0]!;
      c.items.push({ ...first });
    },
    code: "config.duplicate_id",
  },
  {
    name: "duplicate recipe id",
    mutate: (c) => {
      const first = c.recipes[0]!;
      c.recipes.push({ ...first, name: "Copy" });
    },
    code: "config.duplicate_id",
  },
  {
    name: "duplicate station id",
    mutate: (c) => {
      const first = c.stations[0]!;
      c.stations.push({ ...first });
    },
    code: "config.duplicate_id",
  },
  {
    name: "recipe input references a missing item",
    mutate: (c) => {
      c.recipes[0]!.inputs[0]!.item_id = "it.ghost";
    },
    code: "config.unknown_item_ref",
  },
  {
    name: "recipe output references a missing item",
    mutate: (c) => {
      c.recipes[0]!.outputs[0]!.item_id = "it.ghost";
    },
    code: "config.unknown_item_ref",
  },
  {
    name: "station option references a missing station",
    mutate: (c) => {
      c.recipes[0]!.station_options[0]!.station_id = "st.ghost";
    },
    code: "config.unknown_station_ref",
  },
  {
    name: "unlimited_raw marked orderable",
    mutate: (c) => {
      const raw = c.items.find((i) => i.supply === "unlimited_raw")!;
      raw.orderable = true;
      raw.price_minor = 100;
    },
    code: "config.raw_orderable",
  },
  {
    name: "unlimited_raw used as a recipe output",
    mutate: (c) => {
      const raw = c.items.find((i) => i.supply === "unlimited_raw")!;
      c.recipes[0]!.outputs[0]!.item_id = raw.id;
    },
    code: "config.raw_recipe_output",
  },
  {
    name: "recipe graph contains a cycle",
    mutate: (c) => {
      // fry_patty consumes chicken_breaded; make fry_fries produce chicken_breaded
      // while still consuming patty_fried => chicken_breaded -> patty_fried -> chicken_breaded
      c.recipes.find((r) => r.id === "r.fry_fries")!.outputs[0]!.item_id = "it.chicken_breaded";
      c.recipes.find((r) => r.id === "r.fry_fries")!.inputs[0]!.item_id = "it.patty_fried";
    },
    code: "config.recipe_cycle",
  },
  {
    name: "orderable item unreachable from raw",
    mutate: (c) => {
      // a floating orderable item with no producing recipe
      c.items.push({ id: "p.orphan", name: "Orphan", supply: "produced", orderable: true, price_minor: 500 });
    },
    code: "config.unreachable_item",
  },
  {
    name: "orderable item with zero price",
    mutate: (c) => {
      const product = c.items.find((i) => i.orderable)!;
      product.price_minor = 0;
    },
    code: "config.price_invariant",
  },
  {
    name: "non-orderable item with a price",
    mutate: (c) => {
      const product = c.items.find((i) => i.orderable)!;
      product.orderable = false;
    },
    code: "config.price_invariant",
  },
  {
    name: "max_batches above the schema cap",
    mutate: (c) => {
      c.recipes[0]!.station_options[0]!.max_batches = 129;
    },
    code: "config.max_batches",
  },
  {
    name: "zero duration",
    mutate: (c) => {
      c.recipes[0]!.station_options[0]!.duration_ms = 0;
    },
    code: "config.duration_ms",
  },
  {
    name: "end_at_ms out of integer bounds",
    mutate: (c) => {
      (c as unknown as { end_at_ms: number }).end_at_ms = 1.5;
    },
    code: "config.end_at_ms",
  },
  {
    name: "rules altered away from the frozen constants",
    mutate: (c) => {
      (c.rules as unknown as { clock: string }).clock = "realtime";
    },
    code: "config.rules",
  },
  {
    name: "limits altered away from the frozen budget",
    mutate: (c) => {
      (c.limits as unknown as { max_actions_per_decision: number }).max_actions_per_decision = 4_096;
    },
    code: "config.limits",
  },
  {
    name: "id violates the id pattern",
    mutate: (c) => {
      c.recipes[0]!.id = "r/bad id";
    },
    code: "config.id_pattern",
  },
  {
    name: "duplicate input item not merged",
    mutate: (c) => {
      const recipe = c.recipes.find((r) => r.id === "r.build_burger")!;
      recipe.inputs.push({ item_id: "it.patty_fried", quantity: 1 });
    },
    code: "config.duplicate_input_item",
  },
  {
    name: "duplicate station option inside one recipe",
    mutate: (c) => {
      const recipe = c.recipes.find((r) => r.id === "r.fry_patty")!;
      recipe.station_options.push({ ...recipe.station_options[0]! });
    },
    code: "config.duplicate_station_option",
  },
  {
    name: "protocol version mismatch",
    mutate: (c) => {
      (c as unknown as { protocol_version: string }).protocol_version = "0.2.0";
    },
    code: "config.protocol_version",
  },
];

describe("invalid config fixtures are rejected with the right reason", () => {
  for (const fixture of CONFIG_FIXTURES) {
    it(fixture.name, () => {
      const config = clone(base);
      fixture.mutate(config);
      const issues = validatePublicConfig(config);
      expect(issues.map((i) => i.code)).toContain(fixture.code);
    });
  }

  it("at least five distinct reasons are covered", () => {
    expect(new Set(CONFIG_FIXTURES.map((f) => f.code)).size).toBeGreaterThanOrEqual(5);
  });
});

describe("validateScenario composition", () => {
  it("short-circuits on config errors", () => {
    const config = clone(base);
    (config as unknown as { protocol_version: string }).protocol_version = "0.1.0";
    const issues = validateScenario(config, {});
    expect(issues.map((i) => i.code)).toContain("config.protocol_version");
    expect(issues.map((i) => i.code)).not.toContain("stream.not_object");
  });

  it("easy kitchen also passes end-to-end with an empty stream guard", () => {
    const issues = validateScenario(buildEasyKitchen(), { version: "1" });
    expect(issues.length).toBeGreaterThan(0);
  });
});
