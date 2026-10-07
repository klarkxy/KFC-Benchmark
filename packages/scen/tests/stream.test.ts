import { describe, expect, it } from "vitest";

import type { PublicConfig } from "@kitchensched/contracts";

import {
  EASY_KITCHEN,
  KITCHENS,
  MEDIUM_KITCHEN,
  buildEasyKitchen,
  buildMediumKitchen,
} from "../src/kitchens.js";
import {
  GENERATOR_VERSION,
  generateOrderStream,
  materializeOrders,
  orderableItemIds,
  streamStats,
  type OrderStreamFile,
} from "../src/stream.js";
import { validateOrderStream, validateScenario } from "../src/validate.js";

const SEED = 20_261_007;

function streamFor(kitchen = MEDIUM_KITCHEN, seed = SEED): OrderStreamFile {
  const { calibration, config } = kitchen;
  return generateOrderStream(
    config,
    seed,
    {
      interval_ms: calibration.arrivals.interval_ms,
      start_at_ms: calibration.arrivals.start_at_ms,
      end_at_ms: calibration.end_at_ms,
    },
    calibration.demand,
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("stream shape", () => {
  it("round-trips through JSON without value drift", () => {
    const stream = streamFor();
    const revived = JSON.parse(JSON.stringify(stream)) as OrderStreamFile;
    expect(revived).toEqual(stream);
    expect(validateOrderStream(MEDIUM_KITCHEN.config, revived)).toEqual([]);
  });

  it("stamps the generator envelope", () => {
    const stream = streamFor();
    expect(stream.version).toBe("1");
    expect(stream.scenario_id).toBe("medium-01");
    expect(stream.seed).toBe(SEED);
    expect(stream.generator_version).toBe(GENERATOR_VERSION);
    expect(stream.difficulty).toBe("medium");
  });

  it("stores no order ids or values", () => {
    const raw = JSON.stringify(streamFor());
    expect(raw).not.toContain("value_minor");
    expect(raw).not.toMatch(/"id":/);
  });

  it("arrivals are non-decreasing and all strictly before the deadline", () => {
    for (const kitchen of KITCHENS) {
      const stream = streamFor(kitchen);
      const arrivals = stream.orders.map((o) => o.at_ms);
      expect(arrivals.length).toBeGreaterThan(0);
      for (let i = 1; i < arrivals.length; i += 1) {
        expect(arrivals[i] ?? 0).toBeGreaterThanOrEqual(arrivals[i - 1] ?? 0);
      }
      for (const at of arrivals) {
        expect(at).toBeLessThan(kitchen.config.end_at_ms);
        expect(at).toBeGreaterThanOrEqual(kitchen.calibration.arrivals.start_at_ms);
      }
    }
  });

  it("respects the arrival calibration", () => {
    const medium = streamFor();
    expect(medium.orders).toHaveLength(20);
    expect(medium.orders[0]?.at_ms).toBe(60_000);
    expect(medium.orders[19]?.at_ms).toBe(288_000);
    expect(EASY_KITCHEN.config.difficulty).toBe("easy");
    expect(streamFor(EASY_KITCHEN)).toHaveProperty("orders", expect.any(Array));
    expect(streamFor(EASY_KITCHEN).orders).toHaveLength(16);
  });

  it("never emits more orders than max_orders_per_run", () => {
    for (const kitchen of KITCHENS) {
      expect(streamFor(kitchen).orders.length).toBeLessThanOrEqual(kitchen.config.limits.max_orders_per_run);
    }
  });
});

describe("stream contents", () => {
  it("only references orderable items with a positive price", () => {
    const config = MEDIUM_KITCHEN.config;
    const catalog = new Set(orderableItemIds(config));
    for (const order of streamFor().orders) {
      expect(order.items.length).toBeGreaterThanOrEqual(1);
      expect(order.items.length).toBeLessThanOrEqual(4);
      const seen = new Set<string>();
      for (const line of order.items) {
        expect(catalog.has(line.item_id)).toBe(true);
        expect(line.quantity).toBeGreaterThanOrEqual(1);
        expect(line.quantity).toBeLessThanOrEqual(3);
        expect(seen.has(line.item_id)).toBe(false);
        seen.add(line.item_id);
      }
    }
  });

  it("covers the whole catalogue over the stream", () => {
    const stream = streamFor();
    const seen = new Set(stream.orders.flatMap((o) => o.items.map((i) => i.item_id)));
    expect(seen.size).toBe(orderableItemIds(MEDIUM_KITCHEN.config).length);
  });

  it("never puts the same item on one order twice", () => {
    for (const order of streamFor().orders) {
      const ids = order.items.map((i) => i.item_id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("determinism", () => {
  it("same seed yields identical bytes", () => {
    expect(JSON.stringify(streamFor(MEDIUM_KITCHEN, 1))).toBe(JSON.stringify(streamFor(MEDIUM_KITCHEN, 1)));
  });

  it("different seeds yield different streams", () => {
    const a = JSON.stringify(streamFor(MEDIUM_KITCHEN, 1));
    const b = JSON.stringify(streamFor(MEDIUM_KITCHEN, 2));
    expect(a).not.toBe(b);
  });

  it("does not depend on call order or wall clock", () => {
    const first = JSON.stringify(streamFor(MEDIUM_KITCHEN, SEED));
    streamFor(EASY_KITCHEN, 999);
    streamFor(MEDIUM_KITCHEN, 4242);
    expect(JSON.stringify(streamFor(MEDIUM_KITCHEN, SEED))).toBe(first);
  });
});

describe("host-side materialization", () => {
  it("recomputes ids and values from the frozen prices", () => {
    const config = MEDIUM_KITCHEN.config;
    const stream = streamFor();
    const orders = materializeOrders(config, stream);
    const prices = new Map(config.items.map((i) => [i.id, i.price_minor]));
    expect(orders).toHaveLength(stream.orders.length);
    orders.forEach((order, index) => {
      expect(order.id).toBe(`o${index + 1}`);
      expect(order.arrived_at_ms).toBe(stream.orders[index]?.at_ms);
      const expected = order.items.reduce((sum, line) => sum + (prices.get(line.item_id) ?? 0) * line.quantity, 0);
      expect(order.value_minor).toBe(expected);
      expect(Number.isSafeInteger(order.value_minor)).toBe(true);
    });
  });

  it("reports aggregate practice-stream stats", () => {
    const stats = streamStats(MEDIUM_KITCHEN.config, streamFor());
    expect(stats.order_count).toBe(20);
    expect(stats.total_units).toBeGreaterThan(0);
    expect(stats.total_value_minor).toBeGreaterThan(0);
    expect(stats.first_at_ms).toBe(60_000);
    expect(stats.last_at_ms).toBe(288_000);
    // No single product may take the whole order book.
    const units = [...stats.per_item.values()].map((v) => v.units);
    expect(Math.max(...units)).toBeLessThan(stats.total_units / 2);
  });
});

describe("input guards", () => {
  it("rejects a non-positive interval", () => {
    expect(() =>
      generateOrderStream(buildMediumKitchen(), 1, { interval_ms: 0, start_at_ms: 0, end_at_ms: 300_000 }),
    ).toThrow(/interval_ms/);
  });

  it("rejects a kitchen with no orderable items", () => {
    const config = clone(buildMediumKitchen());
    for (const item of config.items) item.orderable = false;
    expect(() =>
      generateOrderStream(config, 1, { interval_ms: 1_000, start_at_ms: 0, end_at_ms: 10_000 }),
    ).toThrow(/no orderable items/);
  });

  it("truncates arrivals that would reach the deadline", () => {
    const stream = generateOrderStream(buildEasyKitchen(), 7, {
      interval_ms: 1_000,
      start_at_ms: 5_000,
      end_at_ms: 8_000,
    });
    expect(stream.orders.map((o) => o.at_ms)).toEqual([5_000, 6_000, 7_000]);
  });
});

/* -------------------------------------------------------------------------- */
/* Invalid stream fixtures                                                    */
/* -------------------------------------------------------------------------- */

type StreamFixture = { name: string; mutate: (stream: OrderStreamFile) => void; code: string };

const STREAM_FIXTURES: StreamFixture[] = [
  {
    name: "arrivals out of order",
    mutate: (s) => {
      const a = s.orders[0];
      const b = s.orders[1];
      if (a && b) {
        a.at_ms = 120_000;
        b.at_ms = 60_000;
      }
    },
    code: "stream.not_sorted",
  },
  {
    name: "arrival at the deadline",
    mutate: (s) => {
      const last = s.orders[s.orders.length - 1];
      if (last) last.at_ms = MEDIUM_KITCHEN.config.end_at_ms;
    },
    code: "stream.at_or_after_deadline",
  },
  {
    name: "unknown item",
    mutate: (s) => {
      const order = s.orders[0];
      if (order) order.items = [{ item_id: "p.does_not_exist", quantity: 1 }];
    },
    code: "stream.unknown_item",
  },
  {
    name: "non-orderable item",
    mutate: (s) => {
      const order = s.orders[0];
      if (order) order.items = [{ item_id: "it.chicken_raw", quantity: 1 }];
    },
    code: "stream.not_orderable",
  },
  {
    name: "too many orders",
    mutate: (s) => {
      const first = s.orders[0];
      if (!first) return;
      const many: OrderStreamFile["orders"] = [];
      for (let i = 0; i < 2_000; i += 1) many.push({ at_ms: 60_000 + i, items: clone(first.items) });
      s.orders = many;
    },
    code: "stream.too_many_orders",
  },
  {
    name: "duplicate line item",
    mutate: (s) => {
      const order = s.orders[0];
      if (order) order.items = [{ item_id: "p.fries", quantity: 1 }, { item_id: "p.fries", quantity: 2 }];
    },
    code: "stream.duplicate_line_item",
  },
  {
    name: "wrong difficulty",
    mutate: (s) => {
      s.difficulty = "complex";
    },
    code: "stream.difficulty",
  },
  {
    name: "wrong scenario id",
    mutate: (s) => {
      s.scenario_id = "medium-99";
    },
    code: "stream.scenario_id",
  },
];

describe("invalid stream fixtures are rejected with the right reason", () => {
  for (const fixture of STREAM_FIXTURES) {
    it(fixture.name, () => {
      const stream = clone(streamFor());
      fixture.mutate(stream);
      const issues = validateOrderStream(MEDIUM_KITCHEN.config, stream);
      expect(issues.map((i) => i.code)).toContain(fixture.code);
    });
  }

  it("validateScenario stops at the config half when the config is broken", () => {
    const config = clone(MEDIUM_KITCHEN.config);
    const orderable = config.items.find((i) => i.orderable)!;
    orderable.price_minor = 0; // orderable item with no price
    const issues = validateScenario(config, streamFor());
    expect(issues.map((i) => i.code)).toContain("config.price_invariant");
  });

  it("accepts a config paired with a foreign-but-valid stream only if ids match", () => {
    const foreign = clone(streamFor(EASY_KITCHEN)) as unknown as OrderStreamFile;
    expect(validateOrderStream(MEDIUM_KITCHEN.config, foreign).map((i) => i.code)).toContain("stream.scenario_id");
  });
});

/* -------------------------------------------------------------------------- */
/* Guards against leaking the internal generator                              */
/* -------------------------------------------------------------------------- */

describe("generator does not leak hidden data into the config", () => {
  it("no seed, opening or distribution field anywhere", () => {
    const text = JSON.stringify(buildMediumKitchen()).toLowerCase();
    for (const forbidden of ["seed", "opening", "distribution", "future_orders", "private"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("config is independent of any stream", () => {
    const before = JSON.stringify(buildMediumKitchen());
    streamFor(MEDIUM_KITCHEN, 777);
    expect(JSON.stringify(buildMediumKitchen())).toBe(before);
  });

  it("config satisfies the frozen contract type", () => {
    const config: PublicConfig = buildMediumKitchen();
    expect(config.scenario_id).toBe("medium-01");
  });
});
