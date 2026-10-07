import { describe, expect, it } from "vitest";
import { runScenario, verifyRun } from "../src/index.js";
import { FakeClock, controller, dec, deliver, eventsOf, makeConfig, order, resultsForCall, scripted, start } from "./fixtures.js";

/** AT21: a malformed response is a protocol error, not a business rejection. */
describe("AT21 malformed decisions", () => {
  const cases: [string, () => unknown][] = [
    ["returns null", () => null],
    ["returns a non-object", () => 42],
    ["returns a string", () => "ok"],
    ["omits actions", () => ({ wake_at_ms: null })],
    ["returns actions as a non-array", () => ({ actions: {}, wake_at_ms: null })],
    ["omits wake_at_ms", () => ({ actions: [] })],
    ["sets wake_at_ms to a string", () => ({ actions: [], wake_at_ms: "100" })],
    ["sets wake_at_ms to undefined", () => ({ actions: [], wake_at_ms: undefined })],
    ["uses an unknown action type", () => ({ actions: [{ type: "cancel", action_id: "x" }], wake_at_ms: null })],
    ["omits action_id", () => ({ actions: [{ type: "start", recipe_id: "r_fries", station_id: "s3", batches: 1, input_lots: [] }], wake_at_ms: null })],
    ["omits recipe_id", () => ({ actions: [{ type: "start", action_id: "x", station_id: "s3", batches: 1, input_lots: [] }], wake_at_ms: null })],
    ["omits input_lots", () => ({ actions: [{ type: "start", action_id: "x", recipe_id: "r_fries", station_id: "s3", batches: 1 }], wake_at_ms: null })],
    ["sends batches as a string", () => ({ actions: [{ type: "start", action_id: "x", recipe_id: "r_fries", station_id: "s3", batches: "1", input_lots: [] }], wake_at_ms: null })],
    ["sends a lot ref without quantity", () => ({ actions: [{ type: "start", action_id: "x", recipe_id: "r_fries", station_id: "s3", batches: 1, input_lots: [{ lot_id: "lot-1" }] }], wake_at_ms: null })],
    ["sends a deliver without output_lots", () => ({ actions: [{ type: "deliver", action_id: "x", order_id: "o1" }], wake_at_ms: null })],
    ["throws", () => {
      throw new Error("candidate exploded");
    }],
  ];

  for (const [name, plan] of cases) {
    it(`ends the run with PROTOCOL_ERROR when the candidate ${name}`, () => {
      const config = makeConfig({ end_at_ms: 2_000 });
      const orders = [order("o1", 500, [["fries", 1]])];
      const candidate = controller(plan);

      const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

      expect(out.result.status).toBe("candidate_failed");
      expect(out.result.failure_code).toBe("PROTOCOL_ERROR");
      expect(out.result.score_minor).toBe(0);
      expect(out.result.revenue_minor).toBe(0);
      expect(out.result.final_action_results).toEqual([]);
      expect(out.result.final_wake_result).toBeNull();
      // The offending response is never executed and the stream keeps what
      // happened before it, ending with run_finished.
      expect(eventsOf(out.events, "task_started")).toHaveLength(0);
      expect(out.events[out.events.length - 1]).toMatchObject({
        type: "run_finished",
        payload: { status: "candidate_failed", score_minor: 0 },
      });
      expect(out.stateHash).toMatch(/^[0-9a-f]{64}$/);
      // A failed run is still replayable up to the failure point.
      expect(verifyRun(config, orders, out.events).ok).toBe(true);
    });
  }

  it("ignores unknown extra fields instead of failing", () => {
    const config = makeConfig({ end_at_ms: 2_000 });
    const candidate = controller(() => ({
      actions: [{ type: "start", action_id: "a1", recipe_id: "r_fries", station_id: "s3", batches: 1, input_lots: [], note: "extra" }],
      wake_at_ms: null,
      request_id: "q1",
      observed_version: 0,
    }));

    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    expect(out.result.status).toBe("completed");
    expect(eventsOf(out.events, "task_started")).toHaveLength(1);
    expect(verifyRun(config, [], out.events).ok).toBe(true);
  });

  it("keeps revenue booked before the failure as diagnostics only", () => {
    const config = makeConfig({ end_at_ms: 2_000 });
    const orders = [order("o1", 800, [["fries", 1]])];
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3")]),
      dec([deliver("d1", "o1", [["lot-1", 1]])]),
    ]);
    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });
    expect(out.result.revenue_minor).toBe(300);

    // Same plan, but the candidate dies on the next callback.
    const broken = scripted([
      dec([start("a1", "r_fries", "s3")]),
      dec([deliver("d1", "o1", [["lot-1", 1]])]),
    ]);
    const original = broken.decide.bind(broken);
    let calls = 0;
    broken.decide = (obs) => {
      calls += 1;
      if (calls > 2) {
        throw new Error("late crash");
      }
      return original(obs);
    };
    const failed = runScenario({ config, orderStream: orders, controller: broken, policy_seed: 1 });

    expect(failed.result.status).toBe("candidate_failed");
    expect(failed.result.score_minor).toBe(0);
    expect(failed.result.revenue_minor).toBe(300);
    expect(failed.result.delivered_orders).toBe(1);
    expect(failed.result.failure_code).toBe("PROTOCOL_ERROR");
  });
});

/** AT22: business rejections never end a run; budget overruns always do. */
describe("AT22 failure and budget policy", () => {
  it("continues after business rejections and still scores", () => {
    const config = makeConfig({ end_at_ms: 3_000 });
    const orders = [order("o1", 1_000, [["fries", 1]])];
    const candidate = scripted([
      dec([
        start("b1", "r_burger", "s1"), // INVALID_INPUT
        start("b2", "r_burger", "s9"), // UNKNOWN_STATION
        start("b3", "r_nope", "s1"), // UNKNOWN_RECIPE
        start("b4", "r_fries", "s1"), // INCOMPATIBLE_STATION
        start("a1", "r_fries", "s3"), // OK
      ]),
      dec([deliver("b5", "o1", [["lot-1", 1]])]), // t=800, UNKNOWN_ORDER: not arrived yet
      dec([deliver("d1", "o1", [["lot-1", 1]])]), // t=1000, OK
    ]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(resultsForCall(candidate, 0).map((r) => r.code)).toEqual([
      "INVALID_INPUT",
      "UNKNOWN_STATION",
      "UNKNOWN_RECIPE",
      "INCOMPATIBLE_STATION",
      "OK",
    ]);
    expect(resultsForCall(candidate, 1)[0]).toMatchObject({ code: "UNKNOWN_ORDER" });
    expect(out.result.status).toBe("completed");
    expect(out.result.score_minor).toBe(300);
    expect(verifyRun(config, orders, out.events).ok).toBe(true);
  });

  it("fails with BUDGET_EXCEEDED past max_decisions and keeps the events so far", () => {
    const config = makeConfig({ end_at_ms: 10_000, limits: { max_decisions: 3 } });
    const orders = [order("o1", 100, [["fries", 1]]), order("o2", 200, [["fries", 1]])];
    const candidate = scripted([]);

    const out = runScenario({ config, orderStream: orders, controller: candidate, policy_seed: 1 });

    expect(out.result.status).toBe("candidate_failed");
    expect(out.result.failure_code).toBe("BUDGET_EXCEEDED");
    expect(out.result.score_minor).toBe(0);
    expect(out.stats.decisions).toBe(3);
    // The three observations that did happen are on the record.
    expect(candidate.observations.map((o) => o.now_ms)).toEqual([0, 100, 200]);
    expect(eventsOf(out.events, "order_arrived")).toHaveLength(2);
    expect(out.events[out.events.length - 1]).toMatchObject({
      type: "run_finished",
      payload: { status: "candidate_failed", score_minor: 0, revenue_minor: 0 },
    });
  });

  it("fails with BUDGET_EXCEEDED past max_actions_per_decision", () => {
    const config = makeConfig({ end_at_ms: 2_000, limits: { max_actions_per_decision: 1 } });
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3"), start("a2", "r_fries", "s3")]),
    ]);

    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    expect(out.result.failure_code).toBe("BUDGET_EXCEEDED");
    expect(out.result.score_minor).toBe(0);
    // The oversized response is not executed at all.
    expect(eventsOf(out.events, "task_started")).toHaveLength(0);
  });

  it("fails with BUDGET_EXCEEDED past max_total_actions", () => {
    const config = makeConfig({ end_at_ms: 2_000, limits: { max_total_actions: 2 } });
    const candidate = scripted([
      dec([start("a1", "r_fries", "s3")]), // 1 action
      dec([start("a2", "r_fries", "s3"), start("a3", "r_fries", "s3")]), // would be 3
    ]);

    const out = runScenario({ config, orderStream: [], controller: candidate, policy_seed: 1 });

    expect(out.result.failure_code).toBe("BUDGET_EXCEEDED");
    expect(out.stats.totalActions).toBe(1);
    expect(eventsOf(out.events, "task_started")).toHaveLength(1);
  });

  it("fails with TIMEOUT when a decision exceeds decision_wall_ms", () => {
    const config = makeConfig({ end_at_ms: 2_000, limits: { decision_wall_ms: 2_000 } });
    const clock = new FakeClock();
    const slow = controller(() => {
      clock.advance(2_001);
      return dec();
    });

    const out = runScenario({
      config,
      orderStream: [],
      controller: slow,
      policy_seed: 1,
      now: clock.now,
    });

    expect(out.result.status).toBe("candidate_failed");
    expect(out.result.failure_code).toBe("TIMEOUT");
    expect(out.result.score_minor).toBe(0);
    expect(out.stats.decisionWallMs).toBe(2_001);
  });

  it("keeps a decision inside its wall-clock budget", () => {
    const config = makeConfig({ end_at_ms: 2_000, limits: { decision_wall_ms: 2_000 } });
    const clock = new FakeClock();
    const brisk = controller(() => {
      clock.advance(10);
      return dec();
    });

    const out = runScenario({
      config,
      orderStream: [],
      controller: brisk,
      policy_seed: 1,
      now: clock.now,
    });

    expect(out.result.status).toBe("completed");
    // Two callbacks, 10ms each.
    expect(out.stats).toMatchObject({ decisions: 2, decisionWallMs: 20 });
    expect(verifyRun(config, [], out.events).ok).toBe(true);
  });

  it("fails with TIMEOUT when init exceeds init_wall_ms", () => {
    const config = makeConfig({ end_at_ms: 2_000, limits: { init_wall_ms: 5_000 } });
    const clock = new FakeClock();
    const candidate = controller(() => dec(), () => clock.advance(5_001));

    const out = runScenario({
      config,
      orderStream: [],
      controller: candidate,
      policy_seed: 1,
      now: clock.now,
    });

    expect(out.result.failure_code).toBe("TIMEOUT");
    expect(out.result.score_minor).toBe(0);
    // The candidate is never asked for a decision.
    expect(candidate.observations).toHaveLength(0);
  });
});
