import { describe, expect, it } from "vitest";
import { runScenario, verifyRun } from "../src/index.js";
import type { WakeResult } from "@kitchensched/contracts";
import {
  dec,
  eventsOf,
  makeConfig,
  nowSeq,
  observeAt,
  order,
  scripted,
  start,
} from "./fixtures.js";

const wakeOf = (w: WakeResult | null): [boolean, string, number | null] | null =>
  w === null ? null : [w.ok, w.code, w.pending_wake_at_ms];
/** AT19: replace, cancel, reject, and survive unrelated callbacks. */
describe("AT19 wake lifecycle", () => {
  it("replaces, keeps on invalid input, cancels, and survives an earlier callback", () => {
    const config = makeConfig({ end_at_ms: 1_000 });
    const orders = [order("o1", 100, [["fries", 1]])];
    const candidate = scripted([
      dec([], 500), // t=0    -> SCHEDULED 500
      dec([], 50), // t=100  -> INVALID_WAKE_TIME (needs >= 120), keeps 500
      dec([], 800), // t=500  -> replaces with 800
      dec([], null), // t=800  -> cancel
      dec([], null), // t=1000 -> nothing pending
        ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(nowSeq(candidate)).toEqual([0, 100, 500, 800, 1_000]);
    // The unrelated order arrival at t=100 did not clear the wake; the wake is
    // still consumed at t=500, which is the callback that observes it as null.
    expect(candidate.observations.map((o) => o.pending_wake_at_ms)).toEqual([
      null, 500, null, null, null,
    ]);
    expect(candidate.observations.map((o) => wakeOf(o.previous_wake_result))).toEqual([
      null,
      [true, "SCHEDULED", 500],
      [false, "INVALID_WAKE_TIME", 500],
      [true, "SCHEDULED", 800],
      [true, "CANCELED", null],
    ]);
    expect(eventsOf(out.events, "wake_fired").map((e) => e.payload.at_ms)).toEqual([500, 800]);
    expect(eventsOf(out.events, "wake_updated").map((e) => [e.at_ms, e.payload.result.code])).toEqual(
      [
        [0, "SCHEDULED"],
        [500, "SCHEDULED"],
      ],
    );
    expect(out.result.final_wake_result).toEqual({
      ok: true,
      code: "CANCELED",
      pending_wake_at_ms: null,
    });
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });

  it("rejects wakes outside [now + min_wake_delay_ms, end_at_ms]", () => {
    const config = makeConfig({ end_at_ms: 1_000, limits: { min_wake_delay_ms: 20 } });
    const orders = [
      order("o1", 100, [["fries", 1]]),
      order("o2", 200, [["fries", 1]]),
      order("o3", 300, [["fries", 1]]),
      order("o4", 400, [["fries", 1]]),
    ];
    const candidate = scripted([
      dec([], 0), // t=0:   now + 0 is not in the future
      dec([], 19), // t=100: one millisecond too early
      dec([], 1_001), // t=200: past the deadline
      dec([], 320.5), // t=300: not an integer
      dec([], 420), // t=400: the earliest legal value
      dec(), // t=420: the wake fires
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(nowSeq(candidate)).toEqual([0, 100, 200, 300, 400, 420, 1_000]);
    // Every rejected wake leaves the pending slot empty; the one legal wake is
    // already consumed by the time its own callback is built.
    expect(candidate.observations.map((o) => o.pending_wake_at_ms)).toEqual([
      null, null, null, null, null, null, null,
    ]);
    expect(candidate.observations.map((o) => wakeOf(o.previous_wake_result))).toEqual([
      null,
      [false, "INVALID_WAKE_TIME", null],
      [false, "INVALID_WAKE_TIME", null],
      [false, "INVALID_WAKE_TIME", null],
      [false, "INVALID_WAKE_TIME", null],
      [true, "SCHEDULED", 420],
      [true, "CANCELED", null],
    ]);
    expect(out.result.status).toBe("completed");
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });

  it("drops a pending wake when the deadline arrives", () => {
    const config = makeConfig({ end_at_ms: 1_000 });
    const candidate = scripted([dec([], 1_000)]); // legal: exactly the deadline

    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    // The wake never fires: the endgame registers no wake, so the run jumps
    // straight to the deadline callback with nothing pending.
    expect(nowSeq(candidate)).toEqual([0, 1_000]);
    expect(eventsOf(out.events, "wake_updated").map((e) => e.payload.result.pending_wake_at_ms)).toEqual([
      1_000,
    ]);
    expect(eventsOf(out.events, "wake_fired")).toHaveLength(0);
    expect(observeAt(candidate, 1)?.final).toBe(true);
    expect(observeAt(candidate, 1)?.pending_wake_at_ms).toBeNull();
    expect(out.result.status).toBe("completed");
    expect(verifyRun(config, [], out.events).ok).toBe(true);
  });
});

/** AT20: one callback per tick, and no zero-time wake loop. */
describe("AT20 wake merging", () => {
  it("merges a wake with a task completion and an order arrival", () => {
    const config = makeConfig({ end_at_ms: 2_000, s3_ms: 1_000 });
    const orders = [order("o1", 1_000, [["fries", 1]])];
    const candidate = scripted([
      dec(
        [
          start("p1", "r_patty", "s4"), // -> 500
          start("p2", "r_patty", "s5"), // -> 500
          start("f1", "r_fries", "s3"), // -> 1000
        ],
        1_000, // wake on the same tick as the fries and the order
      ),
      dec([], 500), // t=500, in the past: rejected, the 1000 wake survives
      dec(), // t=1000, everything lands at once
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(nowSeq(candidate)).toEqual([0, 500, 1_000, 2_000]);
    expect(out.events.filter((e) => e.at_ms === 1_000).map((e) => e.type)).toEqual([
      "clock_advanced",
      "task_completed",
      "order_arrived",
      "wake_fired",
    ]);
    expect(candidate.observations.filter((o) => o.now_ms === 1_000)).toHaveLength(1);
    // The past-dated wake neither replaced nor cancelled the pending one.
    expect(observeAt(candidate, 1)?.pending_wake_at_ms).toBe(1_000);
    expect(eventsOf(out.events, "wake_fired")).toHaveLength(1);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });

  it("never loops in zero sim time", () => {
    const config = makeConfig({ end_at_ms: 600, s3_ms: 200 });
    const orders = [order("o1", 200, [["fries", 1]]), order("o2", 400, [["fries", 1]])];
    // Every decision tries to wake at the current instant.
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3")], 0),
      dec([], 0),
      dec([], 0),
      dec([], 0),
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });
    const times = nowSeq(candidate);

    expect(times).toEqual([0, 200, 400, 600]);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeGreaterThan(times[i - 1] ?? 0);
    }
    expect(eventsOf(out.events, "wake_updated")).toHaveLength(0);
    expect(
      candidate.observations.slice(1).map((o) => wakeOf(o.previous_wake_result)),
    ).toEqual([
      [false, "INVALID_WAKE_TIME", null],
      [false, "INVALID_WAKE_TIME", null],
      [false, "INVALID_WAKE_TIME", null],
    ]);
    expect(out.result.status).toBe("completed");
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });
});
