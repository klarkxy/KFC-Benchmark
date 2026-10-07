import { describe, expect, it } from "vitest";
import { runScenario, verifyRun } from "../src/index.js";
import { canonicalSerialize, type Decision, type Order, type PublicConfig } from "@kitchensched/contracts";
import type { EventPayloads, EventRecord } from "@kitchensched/contracts";
import { Kernel } from "../src/kernel.js";
import { computeStateHash } from "../src/hash.js";
import {
  FakeClock,
  dec,
  deliver,
  makeConfig,
  order,
  scripted,
  start,
} from "./fixtures.js";

/** A full production -> delivery -> wake run, used by the replay tests. */
function scenario(): { config: PublicConfig; orders: Order[]; plan: Decision[] } {
  const config = makeConfig({ end_at_ms: 4_000, s3_ms: 1_000 });
  const orders = [
    order("o1", 500, [["fries", 1]]),
    order("o2", 1_500, [["burger", 1], ["fries", 1]]),
    order("o3", 3_000, [["fries", 1]]),
  ];
  const plan: Decision[] = [
    // t=0: two batches, and hold a wake at 2000 through the next four calls
    dec([start("a1", "r_patty", "s4"), start("a2", "r_fries", "s3", 2)], 2_000),
    // t=500: the patty landed, start the burger
    dec([start("a3", "r_burger", "s1", 1, [["lot-1", 1]])], 2_000),
    dec([], 2_000), // t=1000: the fries landed
    dec([deliver("d1", "o1", [["lot-2", 1]])], 2_000), // t=1500: o1 waits with o2
    // t=2000: the wake fires, the burger is ready, so sell and queue one more
    dec([deliver("d2", "o2", [["lot-3", 1], ["lot-2", 1]]), start("a4", "r_fries", "s3")]),
    dec([deliver("d3", "o3", [["lot-4", 1]])]), // t=3000: o3 arrives with the fries
    dec(), // t=4000: the final callback
  ];
  return { config, orders, plan };
}

/** AT24: identical inputs produce an identical run. */
describe("AT24 determinism", () => {
  it("reproduces events, results and the state hash exactly", () => {
    const { config, orders, plan } = scenario();
    const a = runScenario({ config, orderStream: orders, controller: scripted(plan), policy_seed: 5 });
    const b = runScenario({ config, orderStream: orders, controller: scripted(plan), policy_seed: 5 });

    expect(b.events).toEqual(a.events);
    expect(b.stateHash).toBe(a.stateHash);
    expect(b.result).toEqual(a.result);
    expect(a.result.score_minor).toBe(300 + 800 + 300);
    expect(a.result.delivered_orders).toBe(3);
    expect(verifyRun(config, orders, a.events).ok).toBe(true);
  });

  it("gives the candidate the same seeded random sequence", () => {
    const { config, orders, plan } = scenario();
    const a = scripted(plan);
    const b = scripted(plan);
    runScenario({ config, orderStream: orders, controller: a, policy_seed: 99 });
    runScenario({ config, orderStream: orders, controller: b, policy_seed: 99 });
    expect(b.randoms).toEqual(a.randoms);

    const c = scripted(plan);
    runScenario({ config, orderStream: orders, controller: c, policy_seed: 100 });
    expect(c.randoms).not.toEqual(a.randoms);
  });

  it("keeps wall-clock time out of the state hash", () => {
    const { config, orders, plan } = scenario();
    const slow = new FakeClock();
    const fast = new FakeClock();
    const a = runScenario({
      config,
      orderStream: orders,
      controller: scripted(plan),
      policy_seed: 5,
      now: () => {
        slow.advance(7);
        return slow.now();
      },
    });
    const b = runScenario({
      config,
      orderStream: orders,
      controller: scripted(plan),
      policy_seed: 5,
      now: fast.now,
    });

    expect(a.events).toEqual(b.events);
    expect(a.stateHash).toBe(b.stateHash);
    expect(a.stats.decisionWallMs).not.toBe(b.stats.decisionWallMs);
  });

  it("keeps display names out of the state hash", () => {
    const { config, orders, plan } = scenario();
    const renamed = makeConfig({
      end_at_ms: 4_000,
      s3_ms: 1_000,
      names: "scenario-two",
    });

    const a = runScenario({ config, orderStream: orders, controller: scripted(plan), policy_seed: 5 });
    const b = runScenario({
      config: renamed,
      orderStream: orders,
      controller: scripted(plan),
      policy_seed: 5,
    });

    expect(b.stateHash).toBe(a.stateHash);
  });

  it("hashes exactly the documented projection", () => {
    const { config, orders, plan } = scenario();
    const kernel = new Kernel({ config, orderStream: orders, controller: scripted(plan), policy_seed: 5 });
    const out = kernel.run();

    expect(out.stateHash).toBe(computeStateHash(kernel.hashState()));
    expect(canonicalSerialize(kernel.hashState())).toMatch(
      /^\{"deliveries":\[.*"now_ms":\d+,"orders":\[.*"pending_wake_at_ms":null,"revenue_minor":\d+,"state_version":\d+,"stations":\[.*"tasks":\[.*\}$/,
    );
    kernel.check_conservation();
  });
});

/* ------------------------------------------------------------------ *
 * AT25: the independent judge rejects tampered replays
 * ------------------------------------------------------------------ */

function reseq(events: EventRecord[]): EventRecord[] {
  return events.map((ev, index) => ({ ...ev, seq: index + 1 }));
}

function tamper(
  config: PublicConfig,
  orders: Order[],
  events: EventRecord[],
  type: EventRecord["type"],
  mutate: (payload: EventPayloads[EventRecord["type"]]) => void,
): { ok: boolean; mismatches: string[] } {
  const copy = events.map((ev) => ({ ...ev })) as EventRecord[];
  for (const ev of copy) {
    if (ev.type === type) {
      const mutable = { ...(ev.payload as object) } as Record<string, unknown>;
      mutate(mutable as EventPayloads[EventRecord["type"]]);
      (ev as { payload: unknown }).payload = mutable;
      break;
    }
  }
  return verifyRun(config, orders, reseq(copy));
}

describe("AT25 independent judge", () => {
  const { config, orders, plan } = scenario();
  const out = runScenario({ config, orderStream: orders, controller: scripted(plan), policy_seed: 5 });

  it("accepts the untampered stream", () => {
    expect(verifyRun(config, orders, out.events)).toEqual({ ok: true, mismatches: [] });
  });

  it("rejects a forged output quantity", () => {
    const result = tamper(config, orders, out.events, "task_completed", (payload) => {
      const lots = (payload as EventPayloads["task_completed"]).lots;
      if (lots[0] !== undefined) lots[0] = { ...lots[0], quantity: (lots[0].quantity ?? 1) + 1 };
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/outputs/);
  });

  it("rejects a forged task completion time", () => {
    const result = tamper(config, orders, out.events, "task_completed", (payload) => {
      const p = payload as EventPayloads["task_completed"];
      p.task = { ...p.task, finish_at_ms: p.task.finish_at_ms + 5 };
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/differs from its task_started record/);
  });

  it("rejects a forged task start time and duration", () => {
    const result = tamper(config, orders, out.events, "task_started", (payload) => {
      const p = payload as EventPayloads["task_started"];
      p.task = { ...p.task, finish_at_ms: p.task.finish_at_ms - 1 };
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/!= \d+ \+ \d+/);
  });

  it("rejects a forged delivery value", () => {
    const result = tamper(config, orders, out.events, "order_delivered", (payload) => {
      const p = payload as EventPayloads["order_delivered"];
      p.value_minor = (p.value_minor ?? 0) + 1;
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/books \d+, recomputed \d+/);
  });

  it("rejects a duplicate delivery", () => {
    const first = out.events.find((ev) => ev.type === "order_delivered");
    expect(first).toBeDefined();
    if (first === undefined) return;
    const index = out.events.indexOf(first);
    const doubled = [
      ...out.events.slice(0, index + 1),
      { ...first },
      ...out.events.slice(index + 1),
    ];
    const result = verifyRun(config, orders, reseq(doubled));
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/delivered more than once/);
  });

  it("rejects a delivery for an order that never arrived", () => {
    const result = tamper(config, orders, out.events, "order_arrived", (payload) => {
      const p = payload as EventPayloads["order_arrived"];
      p.order = { ...p.order, arrived_at_ms: 3_999 };
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/arrived_at_ms/);
  });

  it("rejects a dropped arrival", () => {
    const index = out.events.findIndex((ev) => ev.type === "order_arrived");
    const trimmed = [...out.events.slice(0, index), ...out.events.slice(index + 1)];
    const result = verifyRun(config, orders, reseq(trimmed));
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/announced \d+ arrivals/);
  });

  it("rejects a forged revenue total", () => {
    const result = tamper(config, orders, out.events, "run_finished", (payload) => {
      const p = payload as EventPayloads["run_finished"];
      p.revenue_minor = (p.revenue_minor ?? 0) * 2;
      p.score_minor = p.revenue_minor;
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/revenue/);
  });

  it("rejects a state hash that is not sha256 hex", () => {
    const result = tamper(config, orders, out.events, "run_finished", (payload) => {
      const p = payload as EventPayloads["run_finished"];
      p.state_hash = "not-a-hash";
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/state_hash/);
  });

  it("rejects a broken sequence and a missing run_finished", () => {
    const gap = out.events.map((ev, index) => (index === 2 ? { ...ev, seq: 99 } : { ...ev }));
    expect(verifyRun(config, orders, gap).ok).toBe(false);
    const truncated = out.events.slice(0, out.events.length - 1);
    expect(verifyRun(config, orders, truncated).ok).toBe(false);
    expect(verifyRun(config, orders, []).ok).toBe(false);
  });

  it("rejects a stream that sells a lot nobody produced", () => {
    const result = tamper(config, orders, out.events, "order_delivered", (payload) => {
      const p = payload as EventPayloads["order_delivered"];
      p.consumed = [{ lot_id: "lot-999", item_id: "fries", quantity: 2 }];
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/unknown lot lot-999/);
  });

  it("rejects a candidate_failed run that still claims a score", () => {
    const result = tamper(config, orders, out.events, "run_finished", (payload) => {
      const p = payload as EventPayloads["run_finished"];
      p.status = "candidate_failed";
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.join("\n")).toMatch(/must score 0/);
  });
});
