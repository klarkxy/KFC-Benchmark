import type { Difficulty, EndResult, Hash, Id, UInt } from "./types.js";

/**
 * Static result artifacts committed under results/ and consumed by the
 * GitHub Pages site. The site renders only these files; it never
 * recomputes official scores.
 */

export interface SubmissionMeta {
  submission_id: Id;
  /** sha256 of the submission.ts source bytes. */
  source_sha256: Hash;
  /** Free-form label, e.g. "kimi-k3", "gpt-x", "baseline/greedy". */
  model_label: string;
  /** Independent generation index for the same model config (1-based). */
  generation: UInt;
}

export interface RunRecord {
  run_id: Id;
  benchmark_version: string;
  difficulty: Difficulty;
  scenario_id: Id;
  scenario_hash: Hash;
  submission: SubmissionMeta;
  result: EndResult;
  /** sha256 of the canonical final world state; browser re-runs verify it. */
  state_hash: Hash;
  /** Path of the replay file relative to results/, or null if not published. */
  replay: string | null;
  /** Wall-clock stats, informational only. */
  wall: {
    decisions: UInt;
    total_actions: UInt;
    duration_ms: UInt;
  };
  finished_at_iso: string;
}

/** results/<benchmark_version>/runs/<run_id>.json */
export type RunFile = RunRecord;

/**
 * Aggregated leaderboard row: one submission over the case matrix of one
 * difficulty. Aggregation rule (doc 05 §4): equal-weight mean over cases;
 * candidate_failed counts as 0; infra_failed blocks publication.
 */
export interface LeaderboardRow {
  submission: SubmissionMeta;
  difficulty: Difficulty;
  cases: UInt;
  completed: UInt;
  candidate_failed: UInt;
  infra_failed: UInt;
  /** Arithmetic mean of score_minor over the full matrix; null if any infra_failed. */
  mean_score_minor: UInt | null;
  run_ids: Id[];
}

/** results/<benchmark_version>/leaderboard.json */
export interface LeaderboardFile {
  benchmark_version: string;
  generated_at_iso: string;
  engine_version: string;
  protocol_version: string;
  rows: LeaderboardRow[];
}

/** results/index.json — entry point the site fetches first. */
export interface ResultsIndex {
  versions: {
    benchmark_version: string;
    leaderboard: string;
    published_at_iso: string;
  }[];
}
