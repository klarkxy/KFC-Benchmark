import { describe, expect, it } from "vitest";

import type { EndResult, RunRecord, SubmissionMeta } from "@kitchensched/contracts";

import {
  buildLeaderboardFile,
  mergeIndex,
  replayRelativePath,
  runRecordOf,
} from "../src/artifacts.js";
import { matchesGlob, slugifyLabel, submissionIdFor } from "../src/loader.js";
import { policySeedFor, runIdFor, scenarioHashFor } from "../src/runner.js";
import type { RunOutcome } from "../src/runner.js";

const META_A: SubmissionMeta = {
  submission_id: "sub-baselines-greedy-1",
  source_sha256: "a".repeat(64),
  model_label: "baselines/greedy",
  generation: 1,
};

function result(over: Partial<EndResult> = {}): EndResult {
  return {
    status: "completed",
    score_minor: 0,
    revenue_minor: 0,
    delivered_orders: 0,
    failure_code: null,
    final_action_results: [],
    final_wake_result: null,
    ...over,
  };
}

function record(run_id: string, submission: SubmissionMeta, over: Partial<EndResult> = {}): RunRecord {
  return {
    run_id,
    benchmark_version: "p1-test",
    difficulty: "medium",
    scenario_id: "medium-01",
    scenario_hash: "b".repeat(64),
    submission,
    result: result(over),
    state_hash: "c".repeat(64),
    replay: null,
    wall: { decisions: 1, total_actions: 1, duration_ms: 1 },
    finished_at_iso: "2026-10-07T00:00:00.000Z",
  };
}

describe("leaderboard aggregation (doc 05 §4)", () => {
  it("takes the mean of score_minor over the whole case matrix", () => {
    const file = buildLeaderboardFile("p1-test", "2026-10-07T00:00:00.000Z", [
      record("r1", META_A, { score_minor: 100 }),
      record("r2", META_A, { score_minor: 201 }),
      record("r3", META_A, { score_minor: 302 }),
    ]);
    expect(file.rows).toHaveLength(1);
    expect(file.rows[0]?.cases).toBe(3);
    expect(file.rows[0]?.mean_score_minor).toBe(201);
    expect(file.rows[0]?.run_ids).toEqual(["r1", "r2", "r3"]);
  });

  it("counts candidate_failed as zero rather than dropping the case", () => {
    const file = buildLeaderboardFile("p1-test", "2026-10-07T00:00:00.000Z", [
      record("r1", META_A, { score_minor: 300 }),
      record("r2", META_A, {
        status: "candidate_failed",
        score_minor: 0,
        failure_code: "PROTOCOL_ERROR",
      }),
    ]);
    const row = file.rows[0];
    expect(row?.candidate_failed).toBe(1);
    expect(row?.completed).toBe(1);
    expect(row?.cases).toBe(2);
    expect(row?.mean_score_minor).toBe(150);
  });

  it("nulls the mean when any case is infra_failed", () => {
    const file = buildLeaderboardFile("p1-test", "2026-10-07T00:00:00.000Z", [
      record("r1", META_A, { score_minor: 300 }),
      record("r2", META_A, { status: "infra_failed", score_minor: null, failure_code: "JUDGE_MISMATCH" }),
    ]);
    const row = file.rows[0];
    expect(row?.infra_failed).toBe(1);
    expect(row?.mean_score_minor).toBeNull();
  });

  it("keeps one row per submission x difficulty and orders them stably", () => {
    const easy = { ...record("r1", META_A), difficulty: "easy" as const };
    const medium = record("r2", META_A);
    const other: SubmissionMeta = { ...META_A, submission_id: "sub-kimi-k3-1", model_label: "kimi-k3" };
    const file = buildLeaderboardFile("p1-test", "2026-10-07T00:00:00.000Z", [
      record("r9", other),
      medium,
      easy,
      record("r8", META_A, { difficulty: "medium" }),
    ]);
    expect(file.rows.map((row) => `${row.submission.model_label}/${row.difficulty}`)).toEqual([
      "baselines/greedy/easy",
      "baselines/greedy/medium",
      "kimi-k3/medium",
    ]);
    // Input order must not matter.
    const shuffled = buildLeaderboardFile("p1-test", "2026-10-07T00:00:00.000Z", [
      easy,
      record("r8", META_A, { difficulty: "medium" }),
      record("r9", other),
      medium,
    ]);
    expect(shuffled.rows).toEqual(file.rows);
  });
});

describe("results index", () => {
  it("upserts a re-scored version in place and appends new ones", () => {
    const first = mergeIndex(null, "p1-test", "p1-test/leaderboard.json", "2026-10-07T00:00:00.000Z");
    const second = mergeIndex(first, "p2-test", "p2-test/leaderboard.json", "2026-10-08T00:00:00.000Z");
    const again = mergeIndex(second, "p1-test", "p1-test/leaderboard.json", "2026-10-09T00:00:00.000Z");
    expect(again.versions.map((entry) => entry.benchmark_version)).toEqual(["p1-test", "p2-test"]);
    expect(again.versions[0]?.published_at_iso).toBe("2026-10-09T00:00:00.000Z");
    expect(second.versions).toHaveLength(2);
  });
});

describe("run identity", () => {
  it("derives a deterministic uint32 policy seed from the run id", () => {
    const seed = policySeedFor("baselines-greedy-gen1-medium-practice");
    expect(seed).toBe(policySeedFor("baselines-greedy-gen1-medium-practice"));
    expect(seed).not.toBe(policySeedFor("baselines-greedy-gen1-medium-scoring"));
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffff_ffff);
  });

  it("builds filesystem-safe run ids from labels that contain slashes", () => {
    expect(slugifyLabel("baselines/greedy")).toBe("baselines-greedy");
    expect(runIdFor("baselines/greedy", 1, "medium", "practice")).toBe(
      "baselines-greedy-gen1-medium-practice",
    );
    expect(runIdFor("kimi-k3", 2, "easy", "scoring")).toBe("kimi-k3-gen2-easy-scoring");
    expect(submissionIdFor("baselines/greedy", 1)).toBe("sub-baselines-greedy-1");
  });

  it("hashes a config to the same digest regardless of key order", () => {
    expect(scenarioHashFor({ a: 1, b: [2, 3] })).toBe(scenarioHashFor({ b: [2, 3], a: 1 }));
    expect(scenarioHashFor({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("publishes replays under <version>/replays/", () => {
    expect(replayRelativePath("p1-test", "run-1")).toBe("p1-test/replays/run-1.json");
  });
});

describe("submission filter glob", () => {
  it("matches single-segment and multi-segment patterns", () => {
    expect(matchesGlob("baselines/greedy", "baselines/*")).toBe(true);
    expect(matchesGlob("baselines/no-op", "baselines/*")).toBe(true);
    expect(matchesGlob("kimi-k3", "baselines/*")).toBe(false);
    expect(matchesGlob("baselines/greedy", "**/greedy")).toBe(true);
    expect(matchesGlob("greedy", "**/greedy")).toBe(true);
    expect(matchesGlob("kimi-k3", "*")).toBe(true);
    expect(matchesGlob("kimi-k3", "kimi-k?")).toBe(true);
  });
});

describe("run records", () => {
  it("copies the outcome verbatim and leaves the replay to the caller", () => {
    const outcome = {
      run_id: "baselines-greedy-gen1-medium-practice",
      benchmark_version: "p1-test",
      difficulty: "medium",
      scenario_id: "medium-01",
      scenario_hash: "d".repeat(64),
      submission: META_A,
      result: result({ score_minor: 4242, revenue_minor: 4242, delivered_orders: 3 }),
      state_hash: "e".repeat(64),
      replay_kind: "practice",
      events: [],
      policy_seed: 1,
      order_count: 20,
      book_value_minor: 148_940,
      judge_ok: true,
      judge_mismatches: [],
      wall: { decisions: 10, total_actions: 20, duration_ms: 7 },
      finished_at_iso: "2026-10-07T00:00:00.000Z",
      infra_alarm: null,
    } satisfies RunOutcome;

    expect(runRecordOf(outcome, null).replay).toBeNull();
    expect(runRecordOf(outcome, "p1-test/replays/x.json").replay).toBe("p1-test/replays/x.json");
    expect(runRecordOf(outcome, null).result).toEqual(outcome.result);
    expect(runRecordOf(outcome, null).state_hash).toBe(outcome.state_hash);
  });
});