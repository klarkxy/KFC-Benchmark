import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  PROTOCOL_VERSION,
  type LeaderboardFile,
  type LeaderboardRow,
  type OrderStreamMeta,
  type ReplayFile,
  type ResultsIndex,
  type RunRecord,
} from "@kitchensched/contracts";

import { RESULTS_DIR } from "./paths.js";
import { ENGINE_VERSION, type RunOutcome } from "./runner.js";

/**
 * Static result artifacts under results/ — the only thing the Pages site
 * reads (results/index.json -> <ver>/leaderboard.json -> <ver>/runs/*.json).
 *
 * Aggregation rule (doc 05 §4): per submission x difficulty, the arithmetic
 * mean of score_minor over the whole case matrix; candidate_failed already
 * scores 0; ANY infra_failed nulls the mean and blocks publication.
 */

const DIFFICULTY_RANK: Record<string, number> = { easy: 0, medium: 1, complex: 2 };

/** Replay path relative to results/, matching what the site resolves. */
export function replayRelativePath(benchmark_version: string, run_id: string): string {
  return `${benchmark_version}/replays/${run_id}.json`;
}

/**
 * Aggregates run records into the leaderboard. Pure: the same records in
 * always produce the same file, whatever order the runs happened in.
 */
export function buildLeaderboardFile(
  benchmark_version: string,
  generated_at_iso: string,
  runs: readonly RunRecord[],
): LeaderboardFile {
  const groups = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const key = `${run.submission.submission_id}|${run.difficulty}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [run]);
    else bucket.push(run);
  }

  const rows: LeaderboardRow[] = [...groups.values()]
    .map((bucket) => {
      const ordered = [...bucket].sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));
      const head = ordered[0];
      if (head === undefined) throw new Error("buildLeaderboardFile: empty case group");
      let total = 0;
      let completed = 0;
      let candidate_failed = 0;
      let infra_failed = 0;
      for (const run of ordered) {
        if (run.result.status === "completed") completed += 1;
        else if (run.result.status === "candidate_failed") candidate_failed += 1;
        else infra_failed += 1;
        total += run.result.score_minor ?? 0;
      }
      const cases = ordered.length;
      return {
        submission: head.submission,
        difficulty: head.difficulty,
        cases,
        completed,
        candidate_failed,
        infra_failed,
        mean_score_minor: infra_failed > 0 ? null : Math.round(total / cases),
        run_ids: ordered.map((run) => run.run_id),
      };
    })
    .sort((a, b) => {
      const label =
        a.submission.model_label < b.submission.model_label
          ? -1
          : a.submission.model_label > b.submission.model_label
            ? 1
            : a.submission.generation - b.submission.generation;
      if (label !== 0) return label;
      return (DIFFICULTY_RANK[a.difficulty] ?? 99) - (DIFFICULTY_RANK[b.difficulty] ?? 99);
    });

  return {
    benchmark_version,
    generated_at_iso,
    engine_version: ENGINE_VERSION,
    protocol_version: PROTOCOL_VERSION,
    rows,
  };
}

/** Upserts one benchmark version into the site entry point, in place. */
export function mergeIndex(
  existing: ResultsIndex | null,
  benchmark_version: string,
  leaderboard: string,
  published_at_iso: string,
): ResultsIndex {
  const versions = [...(existing?.versions ?? [])];
  const entry = { benchmark_version, leaderboard, published_at_iso };
  const at = versions.findIndex((row) => row.benchmark_version === benchmark_version);
  if (at >= 0) versions[at] = entry;
  else versions.push(entry);
  return { versions };
}

export function runRecordOf(outcome: RunOutcome, replay: string | null): RunRecord {
  return {
    run_id: outcome.run_id,
    benchmark_version: outcome.benchmark_version,
    difficulty: outcome.difficulty,
    scenario_id: outcome.scenario_id,
    scenario_hash: outcome.scenario_hash,
    submission: outcome.submission,
    result: outcome.result,
    state_hash: outcome.state_hash,
    replay,
    wall: outcome.wall,
    finished_at_iso: outcome.finished_at_iso,
  };
}

/**
 * Replay header. Sealed runs never reach disk: publishing them would hand
 * the scored order trajectory to anyone who can read the site.
 */
export function replayFileOf(outcome: RunOutcome, order_stream: OrderStreamMeta): ReplayFile {
  return {
    header: {
      replay_schema_version: "1",
      engine_version: ENGINE_VERSION,
      protocol_version: PROTOCOL_VERSION,
      benchmark_version: outcome.benchmark_version,
      scenario_id: outcome.scenario_id,
      scenario_hash: outcome.scenario_hash,
      clock_mode: "paused_code",
      replay_kind: outcome.replay_kind,
      order_stream,
    },
    events: outcome.events,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export interface WriteResultsOptions {
  benchmark_version: string;
  runs: readonly RunOutcome[];
  /** Replays are written for practice runs only; sealed runs stay unreplayable. */
  publish_replays: boolean;
  /** Public stream metadata for the replay header; sealed runs are never published. */
  stream_meta: Map<string, OrderStreamMeta>;
  results_dir?: string;
  generated_at_iso?: string;
}

export interface WriteResultsOutput {
  records: RunRecord[];
  leaderboard: LeaderboardFile;
  index: ResultsIndex;
}

/** Writes the whole results tree for one benchmark version. */
export function writeResults(opts: WriteResultsOptions): WriteResultsOutput {
  const results_dir = opts.results_dir ?? RESULTS_DIR;
  const generated_at_iso = opts.generated_at_iso ?? new Date().toISOString();
  const version_dir = join(results_dir, opts.benchmark_version);

  // One version directory is regenerated wholesale: a run that no longer
  // happens must not linger in the published tree.
  for (const sub of ["runs", "replays"] as const) {
    const dir = join(version_dir, sub);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  const records: RunRecord[] = [];
  for (const outcome of opts.runs) {
    let replay: string | null = null;
    // A run that never produced events (host load/kernel failure) has nothing
    // to replay; publishing an empty file would misrepresent the binding.
    if (opts.publish_replays && outcome.events.length > 0) {
      const meta = opts.stream_meta.get(outcome.run_id);
      if (meta === undefined || meta.visibility !== "public") {
        throw new Error(
          `refusing to publish a replay for ${outcome.run_id}: no public stream metadata`,
        );
      }
      replay = replayRelativePath(opts.benchmark_version, outcome.run_id);
      writeJson(
        join(results_dir, replay),
        replayFileOf(outcome, {
          visibility: meta.visibility,
          generator_version: meta.generator_version,
          ...(meta.seed === undefined ? {} : { seed: meta.seed }),
        }),
      );
    }
    const record = runRecordOf(outcome, replay);
    writeJson(join(version_dir, "runs", `${outcome.run_id}.json`), record);
    records.push(record);
  }

  records.sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));
  const leaderboard = buildLeaderboardFile(opts.benchmark_version, generated_at_iso, records);
  writeJson(join(version_dir, "leaderboard.json"), leaderboard);

  const index_path = join(results_dir, "index.json");
  const existing = existsSync(index_path)
    ? (JSON.parse(readFileSync(index_path, "utf8")) as ResultsIndex)
    : null;
  const index = mergeIndex(
    existing,
    opts.benchmark_version,
    `${opts.benchmark_version}/leaderboard.json`,
    generated_at_iso,
  );
  writeJson(index_path, index);

  return { records, leaderboard, index };
}